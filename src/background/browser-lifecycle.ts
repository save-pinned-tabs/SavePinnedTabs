/**
 * Coordinates browser startup, window tracking, and automatic tab-set restoration.
 */

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
  isAutoloadScope,
} from '../storage/storage-schema.js';
import { isInteger } from '../validation.js';

export { AUTOLOAD_EVERY_WINDOW, AUTOLOAD_FIRST_WINDOW };

const LIFECYCLE_KEY = 'savePinnedTabs:lifecycle';
const LIFECYCLE_LOCK = 'save-pinned-tabs:browser-lifecycle';
const DEFAULT_STARTUP_WINDOW_ATTEMPTS = 100;

/** Represents work that may complete synchronously or asynchronously. */
type Operation<Result> = () => Result | PromiseLike<Result>;

/** Tracks startup progress and restored windows for the current session. */
interface BrowserLifecycleState {
  /** Indicates whether browser startup initialization has completed. */
  startupObserved: boolean;
  /** Identifies the window selected for first-window autoloading. */
  firstWindowId: number | null;
  /** Lists known open normal browser windows. */
  openNormalWindowIds: number[];
  /** Lists windows that have already received autoloaded sets. */
  restoredWindowIds: number[];
}

/** Allows a value to be supplied immediately or asynchronously. */
type MaybePromise<T> = T | PromiseLike<T>;

/** Serializes access to persisted lifecycle state. */
interface LifecycleStateStorage {
  /** Runs storage work without overlapping another lifecycle operation. */
  runExclusive<Result>(
    operation: Operation<Result>,
  ): Promise<Result>;
  /** Reads the normalized state for the current browser session. */
  read(): Promise<BrowserLifecycleState>;
  /** Persists the current lifecycle state. */
  write(state: BrowserLifecycleState): Promise<void>;
}

/** Extends window tab state with session-wide reset support. */
interface LifecycleWindowTabState extends AutoloadWindowTabState {
  /** Clears tab-state sessions before startup restoration begins. */
  resetSessions(): unknown;
}

/** Provides repositories needed to resolve lifecycle configuration. */
interface LifecycleRepositories {
  readonly tabSets: {
    getAutoload(): Promise<AutoloadConfiguration>;
  };
}

/** Supplies lifecycle dependencies and startup polling behavior. */
interface BrowserLifecycleOptions {
  getAutoload: () => MaybePromise<AutoloadConfiguration>;
  stateStorage: LifecycleStateStorage;
  windows: BrowserApi['windows'];
  windowTabState: LifecycleWindowTabState;
  restoreAutoload(
    windowId: number,
    configuration: AutoloadConfiguration,
  ): unknown;
  delay?: (milliseconds: number) => unknown;
  /** Limits attempts to discover a normal window during startup. */
  startupWindowAttempts?: number;
}

/** Allows lifecycle creation to reuse custom state and repositories. */
interface CreateBrowserLifecycleOptions {
  windowTabState?: LifecycleWindowTabState;
  repositories?: LifecycleRepositories;
}

/** Resolves after the requested delay. */
function wait(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/** Creates an empty state for a newly observed browser session. */
function initialState(): BrowserLifecycleState {
  return {
    startupObserved: false,
    firstWindowId: null,
    openNormalWindowIds: [],
    restoredWindowIds: [],
  };
}

/** Narrows non-null objects to records with unknown properties. */
function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Accepts objects and functions that may expose autoload properties. */
function isPropertyContainer(
  value: unknown,
): value is { readonly scope?: unknown; readonly setIds?: unknown } {
  return (
    (typeof value === 'object' && value !== null)
    || typeof value === 'function'
  );
}



/** Filters stored window identifiers to unique integers in original order. */
function normalizedWindowIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isInteger))];
}

/** Converts unknown persisted data into a valid lifecycle state. */
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

/** Adds an identifier in place while preserving uniqueness. */
function addWindowId(windowIds: number[], windowId: number): void {
  if (!windowIds.includes(windowId)) windowIds.push(windowId);
}

/** Returns a copy that excludes the specified window. */
function removeWindowId(
  windowIds: readonly number[],
  windowId: number,
): number[] {
  return windowIds.filter(
    (storedWindowId) => storedWindowId !== windowId,
  );
}

/** Persists normalized lifecycle state with cross-operation serialization. */
export class BrowserLifecycleStateStorage {
  #sessionStorage: BrowserStorageArea;
  readonly runExclusive: <Result>(
    operation: Operation<Result>,
  ) => Promise<Result>;

  /** Creates storage access or throws when session storage is unavailable. */
  constructor(
    sessionStorage: BrowserStorageArea | null | undefined,
  ) {
    if (!sessionStorage) {
      throw new Error(
        'Browser lifecycle requires browser.storage.session',
      );
    }

    this.#sessionStorage = sessionStorage;
    this.runExclusive = createSerializedStorageOperation(
      sessionStorage,
      LIFECYCLE_LOCK,
    );
  }


  /** Reads and normalizes potentially malformed persisted state. */
  async read(): Promise<BrowserLifecycleState> {
    const stored = await this.#sessionStorage.get(LIFECYCLE_KEY);
    return normalizeState(stored[LIFECYCLE_KEY]);
  }

  /** Normalizes and replaces the persisted lifecycle state. */
  async write(state: unknown): Promise<void> {
    await this.#sessionStorage.set({
      [LIFECYCLE_KEY]: normalizeState(state),
    });
  }
}

/** Coordinates startup autoloading and restoration for newly created windows. */
export class BrowserLifecycle {
  #getAutoload: () => MaybePromise<AutoloadConfiguration>;
  #stateStorage: LifecycleStateStorage;
  #windows: BrowserApi['windows'];
  #windowTabState: LifecycleWindowTabState;
  #restoreAutoload: (
    windowId: number,
    configuration: AutoloadConfiguration,
  ) => unknown;
  #delay: (milliseconds: number) => unknown;
  #startupWindowAttempts: number;

  /** Configures lifecycle orchestration from injected browser services. */
  constructor({
    getAutoload,
    stateStorage,
    windows,
    windowTabState,
    restoreAutoload,
    delay = wait,
    startupWindowAttempts = DEFAULT_STARTUP_WINDOW_ATTEMPTS,
  }: BrowserLifecycleOptions) {
    this.#getAutoload = getAutoload;
    this.#stateStorage = stateStorage;
    this.#windows = windows;
    this.#windowTabState = windowTabState;
    this.#restoreAutoload = restoreAutoload;
    this.#delay = delay;
    this.#startupWindowAttempts = startupWindowAttempts;
  }

  /** Initializes session state and restores eligible startup windows once. */
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

  /** Tracks normal windows and restores them after startup is observed. */
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

  /** Removes closed-window state and deactivates its tab session. */
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

  /** Resets tab sessions and marks startup exactly once. */
  async #initializeStartup(): Promise<void> {
    await this.#stateStorage.runExclusive(async () => {
      const state = normalizeState(await this.#stateStorage.read());
      if (state.startupObserved) return;

      await this.#windowTabState.resetSessions();
      state.startupObserved = true;
      await this.#stateStorage.write(state);
    });
  }

  /** Records a normal window and reports whether startup has been observed. */
  async #rememberNormalWindow(windowId: number): Promise<boolean> {
    return this.#stateStorage.runExclusive(async () => {
      const state = normalizeState(await this.#stateStorage.read());
      addWindowId(state.openNormalWindowIds, windowId);
      await this.#stateStorage.write(state);
      return state.startupObserved;
    });
  }

  /** Polls for startup windows until one appears or attempts are exhausted. */
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

  /** Combines tracked and currently reported normal window identifiers. */
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

  /** Restores an eligible window once and records successful completion. */
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

  /** Validates repository configuration and throws for unsupported values. */
  async #autoloadConfiguration(): Promise<AutoloadConfiguration> {
    const configuration = await this.#getAutoload();
    if (
      !isPropertyContainer(configuration)
      || !isAutoloadScope(configuration.scope)
    ) {
      const scope = isPropertyContainer(configuration)
        ? configuration.scope
        : undefined;
      throw new TypeError(`Unsupported Autoload scope "${String(scope)}"`);
    }
    if (!Array.isArray(configuration.setIds)) {
      throw new TypeError('Autoload setIds must be an array');
    }
    if (!configuration.setIds.every((setId) => typeof setId === 'string')) {
      throw new TypeError('Autoload setIds must contain only strings');
    }
    return {
      scope: configuration.scope,
      setIds: configuration.setIds,
    };
  }
}

/** Creates a lifecycle coordinator backed by browser storage and repositories. */
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
    /** Restores configured autoload sets into the target window. */
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