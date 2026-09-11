import type {
  AutoloadConfiguration,
  BrowserCommand,
  CommandResult,
  ExportDocument,
  OptionsState,
  PopupState,
  TabSet,
  TabSetDetails,
  TabSetId,
  WindowId,
} from '../domain.js';
import { errorMessage } from '../validation.js';


interface TabSets {
  list(): Promise<TabSet[]>;
  remove(setId: TabSetId): Promise<void>;
  getAutoload(): Promise<AutoloadConfiguration>;
  setAutoload(configuration: AutoloadConfiguration): Promise<void>;
  export(): Promise<ExportDocument>;
  import(document: unknown): Promise<TabSet[]>;
}

interface WindowSessions {
  get(windowId: WindowId): Promise<TabSetId | null | undefined>;
}

interface ShortcutAssignments {
  assign(command: string, setId: TabSetId): Promise<void>;
  list(): Promise<Partial<Record<string, TabSetId>>>;
}

interface WindowTabState {
  captureAndSave(
    windowId: WindowId,
    details: TabSetDetails,
  ): Promise<TabSet | null>;
  replace(windowId: WindowId, setId: TabSetId): Promise<string[]>;
  append(windowId: WindowId, setId: TabSetId): Promise<string[]>;
  unload(windowId: WindowId, setId: TabSetId): Promise<string[]>;
}

export interface TabSetControllerDependencies {
  tabSets: TabSets;
  windowSessions: WindowSessions;
  shortcutAssignments: ShortcutAssignments;
  windowTabState: WindowTabState;
  getCurrentWindowId(): Promise<WindowId>;
  getLastFocusedWindowId(): Promise<WindowId | null | undefined>;
  listBrowserCommands(): Promise<BrowserCommand[]>;
}

function commandError(command: string, cause: unknown): Error {
  return new Error(`Failed to ${command}: ${errorMessage(cause)}`, { cause });
}

export class TabSetController {
  readonly #dependencies: TabSetControllerDependencies;

  constructor(dependencies: TabSetControllerDependencies) {
    this.#dependencies = dependencies;
  }

  getPopupState() {
    return this.#execute('load popup state', async () => {
      const windowId = await this.#dependencies.getCurrentWindowId();
      return { state: await this.#popupState(windowId) };
    });
  }

  saveSet(name: string, setId?: TabSetId) {
    return this.#execute('save tab set', async () => {
      const windowId = await this.#dependencies.getCurrentWindowId();
      const savedSet = await this.#dependencies.windowTabState.captureAndSave(
        windowId,
        { id: setId, name },
      );
      if (!savedSet) throw new Error('No pinned tabs found.');
      return { savedSet, state: await this.#popupState(windowId) };
    });
  }

  loadSet(setId: TabSetId) {
    return this.#updatePopupState('load tab set', setId, 'replace');
  }

  appendSet(setId: TabSetId) {
    return this.#updatePopupState('append tab set', setId, 'append');
  }

  unloadSet(setId: TabSetId) {
    return this.#updatePopupState('unload tab set', setId, 'unload');
  }

  deleteSet(setId: TabSetId) {
    return this.#execute('delete tab set', async () => {
      const windowId = await this.#dependencies.getCurrentWindowId();
      await this.#dependencies.tabSets.remove(setId);
      return { state: await this.#popupState(windowId) };
    });
  }

  setAutoload(setId: TabSetId, enabled: boolean) {
    return this.#execute('update autoload selection', async () => {
      const windowId = await this.#dependencies.getCurrentWindowId();
      const configuration = await this.#dependencies.tabSets.getAutoload();
      const setIds = new Set(configuration.setIds);
      if (enabled) setIds.add(setId);
      else setIds.delete(setId);
      await this.#dependencies.tabSets.setAutoload({
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
      await this.#dependencies.shortcutAssignments.assign(command, setId);
      return { state: await this.#optionsState() };
    });
  }

  exportSets() {
    return this.#execute(
      'export tab sets',
      () => this.#dependencies.tabSets.export(),
    );
  }

  importSets(document: unknown) {
    return this.#execute('import tab sets', async () => {
      const imported = await this.#dependencies.tabSets.import(document);
      return {
        importedCount: imported.length,
        state: await this.#optionsState(),
      };
    });
  }

  runShortcut(command: string) {
    return this.#execute(`run tab-set command "${command}"`, async () => {
      const setId = (await this.#dependencies.shortcutAssignments.list())[command];
      if (!setId) return { executed: false };

      const windowId = await this.#dependencies.getLastFocusedWindowId();
      if (windowId === null || windowId === undefined) {
        return { executed: false };
      }
      await this.#dependencies.windowTabState.replace(windowId, setId);
      return { executed: true };
    });
  }

  async #updatePopupState(
    command: string,
    setId: TabSetId,
    operation: 'replace' | 'append' | 'unload',
  ) {
    return this.#execute(command, async () => {
      const windowId = await this.#dependencies.getCurrentWindowId();
      await this.#dependencies.windowTabState[operation](windowId, setId);
      return { state: await this.#popupState(windowId) };
    });
  }

  async #popupState(windowId: WindowId): Promise<PopupState> {
    const [sets, activeSetId, autoload] = await Promise.all([
      this.#dependencies.tabSets.list(),
      this.#dependencies.windowSessions.get(windowId),
      this.#dependencies.tabSets.getAutoload(),
    ]);
    return {
      sets,
      activeSetId: activeSetId ?? null,
      autoloadSetIds: autoload.setIds,
    };
  }

  async #optionsState(): Promise<OptionsState> {
    const [sets, assignments, commands] = await Promise.all([
      this.#dependencies.tabSets.list(),
      this.#dependencies.shortcutAssignments.list(),
      this.#dependencies.listBrowserCommands(),
    ]);
    return { sets, assignments, commands };
  }

  async #execute<T>(
    command: string,
    operation: () => Promise<T>,
  ): Promise<CommandResult<T>> {
    try {
      return { status: 'success', value: await operation() };
    } catch (error: unknown) {
      return { status: 'error', error: commandError(command, error) };
    }
  }
}