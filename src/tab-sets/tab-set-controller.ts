import type { TabSet } from '../domain.js';

type TabSetId = TabSet['id'];
type TabSetName = TabSet['name'];
type WindowId = number;
type MaybePromise<T> = T | PromiseLike<T>;

interface AutoloadConfiguration<Scope> {
  scope: Scope;
  setIds: TabSetId[];
}

interface ImportResult {
  readonly length: number;
}

interface TabSets<ExportDocument, AutoloadScope> {
  list(): MaybePromise<TabSet[]>;
  remove(setId: TabSetId): MaybePromise<unknown>;
  getAutoload(): MaybePromise<AutoloadConfiguration<AutoloadScope>>;
  setAutoload(
    configuration: AutoloadConfiguration<AutoloadScope>,
  ): MaybePromise<unknown>;
  export(): MaybePromise<ExportDocument>;
  import(document: unknown): MaybePromise<ImportResult>;
}

interface WindowSessions {
  get(windowId: WindowId): MaybePromise<TabSetId | null | undefined>;
}

interface ShortcutAssignments {
  assign(command: string, setId: TabSetId): MaybePromise<unknown>;
  list(): MaybePromise<Partial<Record<string, TabSetId>>>;
}

interface SaveSetDetails {
  id: TabSetId | undefined;
  name: TabSetName;
}

interface WindowTabState {
  captureAndSave(
    windowId: WindowId,
    details: SaveSetDetails,
  ): MaybePromise<TabSet | null | undefined>;
  replace(windowId: WindowId, setId: TabSetId): MaybePromise<unknown>;
  append(windowId: WindowId, setId: TabSetId): MaybePromise<unknown>;
  unload(windowId: WindowId, setId: TabSetId): MaybePromise<unknown>;
}

interface TabSetControllerOptions<
  ExportDocument,
  BrowserCommand,
  AutoloadScope,
> {
  tabSets: TabSets<ExportDocument, AutoloadScope>;
  windowSessions: WindowSessions;
  shortcutAssignments: ShortcutAssignments;
  windowTabState: WindowTabState;
  getCurrentWindowId: () => MaybePromise<WindowId>;
  getLastFocusedWindowId: () => MaybePromise<
    WindowId | null | undefined
  >;
  listBrowserCommands: () => MaybePromise<BrowserCommand[]>;
}

interface Success<T> {
  status: 'success';
  value: T;
}

interface Failure {
  status: 'error';
  error: Error;
}

type CommandResult<T> = Success<T> | Failure;

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;

  if (
    typeof cause === 'object' &&
    cause !== null &&
    'message' in cause &&
    typeof cause.message === 'string'
  ) {
    return cause.message;
  }

  return String(cause);
}

function commandError(command: string, cause: unknown): Error {
  return new Error(`Failed to ${command}: ${errorMessage(cause)}`, { cause });
}

function success<T>(value: T): Success<T> {
  return { status: 'success', value };
}

function failure(command: string, error: unknown): Failure {
  return { status: 'error', error: commandError(command, error) };
}

export class TabSetController<
  ExportDocument = unknown,
  BrowserCommand = unknown,
  AutoloadScope = unknown,
> {
  #tabSets: TabSets<ExportDocument, AutoloadScope>;
  #windowSessions: WindowSessions;
  #shortcutAssignments: ShortcutAssignments;
  #windowTabState: WindowTabState;
  #getCurrentWindowId: () => MaybePromise<WindowId>;
  #getLastFocusedWindowId: () => MaybePromise<
    WindowId | null | undefined
  >;
  #listBrowserCommands: () => MaybePromise<BrowserCommand[]>;

  constructor({
    tabSets,
    windowSessions,
    shortcutAssignments,
    windowTabState,
    getCurrentWindowId,
    getLastFocusedWindowId,
    listBrowserCommands,
  }: TabSetControllerOptions<
    ExportDocument,
    BrowserCommand,
    AutoloadScope
  >) {
    this.#tabSets = tabSets;
    this.#windowSessions = windowSessions;
    this.#shortcutAssignments = shortcutAssignments;
    this.#windowTabState = windowTabState;
    this.#getCurrentWindowId = getCurrentWindowId;
    this.#getLastFocusedWindowId = getLastFocusedWindowId;
    this.#listBrowserCommands = listBrowserCommands;
  }

  getPopupState() {
    return this.#execute('load popup state', async () => {
      const windowId = await this.#getCurrentWindowId();
      return { state: await this.#popupState(windowId) };
    });
  }

  saveSet(name: TabSetName, setId?: TabSetId) {
    return this.#execute('save tab set', async () => {
      const windowId = await this.#getCurrentWindowId();
      const savedSet = await this.#windowTabState.captureAndSave(windowId, {
        id: setId,
        name,
      });

      if (!savedSet) throw new Error('No pinned tabs found.');

      return { savedSet, state: await this.#popupState(windowId) };
    });
  }

  loadSet(setId: TabSetId) {
    return this.#execute('load tab set', async () => {
      const windowId = await this.#getCurrentWindowId();
      await this.#windowTabState.replace(windowId, setId);
      return { state: await this.#popupState(windowId) };
    });
  }

  appendSet(setId: TabSetId) {
    return this.#execute('append tab set', async () => {
      const windowId = await this.#getCurrentWindowId();
      await this.#windowTabState.append(windowId, setId);
      return { state: await this.#popupState(windowId) };
    });
  }

  unloadSet(setId: TabSetId) {
    return this.#execute('unload tab set', async () => {
      const windowId = await this.#getCurrentWindowId();
      await this.#windowTabState.unload(windowId, setId);
      return { state: await this.#popupState(windowId) };
    });
  }

  deleteSet(setId: TabSetId) {
    return this.#execute('delete tab set', async () => {
      const windowId = await this.#getCurrentWindowId();
      await this.#tabSets.remove(setId);
      return { state: await this.#popupState(windowId) };
    });
  }

  setAutoload(setId: TabSetId, enabled: boolean) {
    return this.#execute('update autoload selection', async () => {
      const windowId = await this.#getCurrentWindowId();
      const configuration = await this.#tabSets.getAutoload();
      const setIds = new Set(configuration.setIds);

      if (enabled) setIds.add(setId);
      else setIds.delete(setId);

      await this.#tabSets.setAutoload({
        scope: configuration.scope,
        setIds: [...setIds],
      });

      return { state: await this.#popupState(windowId) };
    });
  }

  getOptionsState() {
    return this.#execute('load options state', async () => ({
      state: await this.#optionsState(),
    }));
  }

  assignShortcut(command: string, setId: TabSetId) {
    return this.#execute('assign keyboard shortcut', async () => {
      await this.#shortcutAssignments.assign(command, setId);
      return { state: await this.#optionsState() };
    });
  }

  exportSets() {
    return this.#execute('export tab sets', () => this.#tabSets.export());
  }

  importSets(document: unknown) {
    return this.#execute('import tab sets', async () => {
      const imported = await this.#tabSets.import(document);

      return {
        importedCount: imported.length,
        state: await this.#optionsState(),
      };
    });
  }

  runShortcut(command: string) {
    return this.#execute(`run tab-set command "${command}"`, async () => {
      const setId = (await this.#shortcutAssignments.list())[command];
      if (!setId) return { executed: false };

      const windowId = await this.#getLastFocusedWindowId();
      if (windowId === null || windowId === undefined) {
        return { executed: false };
      }

      await this.#windowTabState.replace(windowId, setId);
      return { executed: true };
    });
  }

  async #popupState(windowId: WindowId) {
    const [sets, activeSetId, autoload] = await Promise.all([
      this.#tabSets.list(),
      this.#windowSessions.get(windowId),
      this.#tabSets.getAutoload(),
    ]);

    return {
      sets,
      activeSetId: activeSetId ?? null,
      autoloadSetIds: autoload.setIds,
    };
  }

  async #optionsState() {
    const [sets, assignments, commands] = await Promise.all([
      this.#tabSets.list(),
      this.#shortcutAssignments.list(),
      this.#listBrowserCommands(),
    ]);

    return { sets, assignments, commands };
  }

  async #execute<T>(
    command: string,
    operation: () => T,
  ): Promise<CommandResult<Awaited<T>>> {
    try {
      return success(await operation());
    } catch (error: unknown) {
      return failure(command, error);
    }
  }
}