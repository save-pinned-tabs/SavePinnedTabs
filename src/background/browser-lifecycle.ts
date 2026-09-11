import type {
  BrowserApi,
  BrowserStorageArea,
  BrowserWindow,
} from '../browser-api.js';
import type { AutoloadConfiguration, AutoloadScope } from '../domain.js';
import {
  restoreAutoloadSets,
  type AutoloadWindowTabState,
} from './autoload.js';
import { createSerializedStorageOperation } from '../storage/serialized-operation.js';
import { createBrowserWindowTabState } from '../storage/window-tab-state.js';
import { createBrowserRepositories } from '../storage/browser-repositories.js';
import {
  AUTOLOAD_EVERY_WINDOW,
  AUTOLOAD_FIRST_WINDOW,
  AUTOLOAD_SCOPES,
} from '../storage/storage-schema.js';

export { AUTOLOAD_EVERY_WINDOW, AUTOLOAD_FIRST_WINDOW };

const LIFECYCLE_KEY = 'savePinnedTabs:lifecycle';
const LIFECYCLE_LOCK = 'save-pinned-tabs:browser-lifecycle';
const DEFAULT_STARTUP_WINDOW_ATTEMPTS = 100;

type Operation<Result> = () => Result | PromiseLike<Result>;

interface BrowserLifecycleState {
  startupObserved: boolean;
  firstWindowId: number | null;
  openNormalWindowIds: number[];
  restoredWindowIds: number[];
}

interface LifecycleStateStorage {
  runExclusive<Result>(
    operation: Operation<Result>,
  ): Promise<Result>;
  read(): Promise<BrowserLifecycleState>;
  write(state: BrowserLifecycleState): Promise<void>;
}

interface LifecycleWindowTabState extends AutoloadWindowTabState {
  resetSessions(): unknown;
}

interface LifecycleRepositories {
  readonly tabSets: {
    getAutoload(): PromiseLike<unknown> | unknown;
  };
}

interface BrowserLifecycleOptions {
  autoloadPolicy?: unknown;
  getAutoload?: (() => PromiseLike<unknown> | unknown) | null;
  stateStorage: LifecycleStateStorage;
  windows: BrowserApi['windows'];
  windowTabState: LifecycleWindowTabState;
  restoreAutoload(
    windowId: number,
    configuration: AutoloadConfiguration,
  ): PromiseLike<unknown> | unknown;
  delay?: (milliseconds: number) => PromiseLike<unknown> | unknown;
  startupWindowAttempts?: number;
}

interface CreateBrowserLifecycleOptions {
  windowTabState?: LifecycleWindowTabState;
  repositories?: LifecycleRepositories;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function initialState(): BrowserLifecycleState {
  return {
    startupObserved: false,
    firstWindowId: null,
    openNormalWindowIds: [],
    restoredWindowIds: [],
  };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPropertyContainer(
  value: unknown,
): value is { readonly scope?: unknown; readonly setIds?: unknown } {
  return (
    (typeof value === 'object' && value !== null)
    || typeof value === 'function'
  );
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isAutoloadScope(value: unknown): value is AutoloadScope {
  for (const scope of AUTOLOAD_SCOPES) {
    if (scope === value) return true;
  }
  return false;
}

function isAutoloadConfiguration(
  value: unknown,
): value is AutoloadConfiguration {
  return (
    isPropertyContainer(value)
    && isAutoloadScope(value.scope)
    && Array.isArray(value.setIds)
  );
}

function configurationScope(value: unknown): unknown {
  return isPropertyContainer(value) ? value.scope : undefined;
}

function normalizedWindowIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isInteger))];
}

function normalizeState(storedState: unknown): BrowserLifecycleState {
  if (!isObjectRecord(storedState)) return initialState();

  return {
    startupObserved: storedState.startupObserved === true,
    firstWindowId: isInteger(storedState.firstWindowId)
      ? storedState.firstWindowId
      : null,
    openNormalWindowIds: normalizedWindowIds(
      storedState.openNormalWindowIds,
    ),
    restoredWindowIds: normalizedWindowIds(storedState.restoredWindowIds),
  };
}

function addWindowId(windowIds: number[], windowId: number): void {
  if (!windowIds.includes(windowId)) windowIds.push(windowId);
}

function removeWindowId(
  windowIds: readonly number[],
  windowId: number,
): number[] {
  return windowIds.filter(
    (storedWindowId) => storedWindowId !== windowId,
  );
}

export class BrowserLifecycleStateStorage {
  #sessionStorage: BrowserStorageArea;
  #runExclusive: <Result>(
    operation: Operation<Result>,
  ) => Promise<Result>;

  constructor(
    sessionStorage: BrowserStorageArea | null | undefined,
  ) {
    if (!sessionStorage) {
      throw new Error(
        'Browser lifecycle requires browser.storage.session',
      );
    }

    this.#sessionStorage = sessionStorage;
    this.#runExclusive = createSerializedStorageOperation(
      sessionStorage,
      LIFECYCLE_LOCK,
    );
  }

  runExclusive<Result>(
    operation: Operation<Result>,
  ): Promise<Result> {
    return this.#runExclusive(operation);
  }

  async read(): Promise<BrowserLifecycleState> {
    const stored = await this.#sessionStorage.get(LIFECYCLE_KEY);
    return normalizeState(stored[LIFECYCLE_KEY]);
  }

  async write(state: unknown): Promise<void> {
    await this.#sessionStorage.set({
      [LIFECYCLE_KEY]: normalizeState(state),
    });
  }
}

export class BrowserLifecycle {
  #getAutoload: () => PromiseLike<unknown> | unknown;
  #stateStorage: LifecycleStateStorage;
  #windows: BrowserApi['windows'];
  #windowTabState: LifecycleWindowTabState;
  #restoreAutoload: (
    windowId: number,
    configuration: AutoloadConfiguration,
  ) => PromiseLike<unknown> | unknown;
  #delay: (milliseconds: number) => PromiseLike<unknown> | unknown;
  #startupWindowAttempts: number;

  constructor({
    autoloadPolicy,
    getAutoload,
    stateStorage,
    windows,
    windowTabState,
    restoreAutoload,
    delay = wait,
    startupWindowAttempts = DEFAULT_STARTUP_WINDOW_ATTEMPTS,
  }: BrowserLifecycleOptions) {
    if (!getAutoload && !isAutoloadScope(autoloadPolicy)) {
      throw new TypeError(
        `Unsupported Autoload scope "${String(autoloadPolicy)}"`,
      );
    }

    this.#getAutoload = getAutoload ?? (() => ({
      scope: autoloadPolicy,
      setIds: [],
    }));
    this.#stateStorage = stateStorage;
    this.#windows = windows;
    this.#windowTabState = windowTabState;
    this.#restoreAutoload = restoreAutoload;
    this.#delay = delay;
    this.#startupWindowAttempts = startupWindowAttempts;
  }

  async onBrowserStartup(): Promise<void> {
    await this.#initializeStartup();

    const configuration = await this.#autoloadConfiguration();
    const startupWindowIds = await this.#findStartupWindowIds();
    const targets = configuration.scope === AUTOLOAD_FIRST_WINDOW
      ? startupWindowIds.slice(0, 1)
      : startupWindowIds;

    await Promise.all(
      targets.map(
        (windowId) => this.#restoreWindowOnce(windowId, configuration),
      ),
    );
  }

  async onWindowCreated(
    window: BrowserWindow | null | undefined,
  ): Promise<void> {
    if (window?.type !== 'normal' || !isInteger(window.id)) return;

    const startupObserved = await this.#rememberNormalWindow(window.id);
    if (startupObserved) {
      await this.#restoreWindowOnce(
        window.id,
        await this.#autoloadConfiguration(),
      );
    }
  }

  async onWindowRemoved(windowId: number): Promise<void> {
    await this.#stateStorage.runExclusive(async () => {
      const state = normalizeState(await this.#stateStorage.read());
      state.openNormalWindowIds = removeWindowId(
        state.openNormalWindowIds,
        windowId,
      );
      state.restoredWindowIds = removeWindowId(
        state.restoredWindowIds,
        windowId,
      );

      await this.#stateStorage.write(state);
      await this.#windowTabState.deactivate(windowId);
    });
  }

  async #initializeStartup(): Promise<void> {
    await this.#stateStorage.runExclusive(async () => {
      const state = normalizeState(await this.#stateStorage.read());
      if (state.startupObserved) return;

      await this.#windowTabState.resetSessions();
      state.startupObserved = true;
      await this.#stateStorage.write(state);
    });
  }

  async #rememberNormalWindow(windowId: number): Promise<boolean> {
    return this.#stateStorage.runExclusive(async () => {
      const state = normalizeState(await this.#stateStorage.read());
      addWindowId(state.openNormalWindowIds, windowId);
      await this.#stateStorage.write(state);
      return state.startupObserved;
    });
  }

  async #findStartupWindowIds(): Promise<number[]> {
    for (
      let attempt = 0;
      attempt < this.#startupWindowAttempts;
      attempt += 1
    ) {
      const windowIds = await this.#currentNormalWindowIds();
      if (windowIds.length > 0) return windowIds;
      await this.#delay(50);
    }

    return [];
  }

  async #currentNormalWindowIds(): Promise<number[]> {
    const state = normalizeState(await this.#stateStorage.read());
    const windowIds = new Set(state.openNormalWindowIds);
    const currentWindows = await this.#windows.getAll(null);

    for (const window of currentWindows) {
      if (window?.type === 'normal' && isInteger(window.id)) {
        windowIds.add(window.id);
      }
    }

    return [...windowIds];
  }

  async #restoreWindowOnce(
    windowId: number,
    configuration: AutoloadConfiguration,
  ): Promise<void> {
    await this.#stateStorage.runExclusive(async () => {
      const state = normalizeState(await this.#stateStorage.read());

      if (
        !state.startupObserved
        || state.restoredWindowIds.includes(windowId)
      ) {
        return;
      }

      if (
        configuration.scope === AUTOLOAD_FIRST_WINDOW
        && state.firstWindowId !== null
      ) {
        return;
      }

      await this.#restoreAutoload(windowId, configuration);
      addWindowId(state.restoredWindowIds, windowId);

      if (configuration.scope === AUTOLOAD_FIRST_WINDOW) {
        state.firstWindowId = windowId;
      }

      await this.#stateStorage.write(state);
    });
  }

  async #autoloadConfiguration(): Promise<AutoloadConfiguration> {
    const configuration = await this.#getAutoload();

    if (!isAutoloadConfiguration(configuration)) {
      throw new TypeError(
        `Unsupported Autoload scope "${String(
          configurationScope(configuration),
        )}"`,
      );
    }

    return configuration;
  }
}

export function createBrowserLifecycle(
  browser: BrowserApi,
  {
    windowTabState = createBrowserWindowTabState(browser),
    repositories = createBrowserRepositories(browser),
  }: CreateBrowserLifecycleOptions = {},
): BrowserLifecycle {
  return new BrowserLifecycle({
    getAutoload: () => repositories.tabSets.getAutoload(),
    stateStorage: new BrowserLifecycleStateStorage(
      browser.storage.session,
    ),
    windows: browser.windows,
    windowTabState,
    restoreAutoload(windowId, configuration) {
      return restoreAutoloadSets(
        browser,
        windowId,
        configuration,
        windowTabState,
      );
    },
  });
}