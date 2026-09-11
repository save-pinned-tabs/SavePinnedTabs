/** Coordinates tab-set persistence, window state, shortcuts, and UI state retrieval. */

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



/** Provides persistent storage and import/export operations for tab sets. */
interface TabSets {
  /** Lists all saved tab sets. */
  list(): Promise<TabSet[]>;

  /** Permanently removes a saved tab set. */
  remove(setId: TabSetId): Promise<void>;

  /** Retrieves the current autoload configuration. */
  getAutoload(): Promise<AutoloadConfiguration>;

  /** Replaces the current autoload configuration. */
  setAutoload(configuration: AutoloadConfiguration): Promise<void>;

  /** Serializes all tab-set data for external storage. */
  export(): Promise<ExportDocument>;

  /** Validates and persists tab sets from an external document. */
  import(document: unknown): Promise<TabSet[]>;
}

/** Resolves the active tab set associated with a browser window. */
interface WindowSessions {
  /** Returns no identifier when the window has no active tab set. */
  get(windowId: WindowId): Promise<TabSetId | null | undefined>;
}

/** Manages associations between browser commands and saved tab sets. */
interface ShortcutAssignments {
  /** Associates a browser command with a tab set. */
  assign(command: string, setId: TabSetId): Promise<void>;

  /** Lists the currently configured command assignments. */
  list(): Promise<Partial<Record<string, TabSetId>>>;
}

/** Applies saved tab sets to browser windows and captures pinned tabs. */
interface WindowTabState {
  /** Saves the window's pinned tabs, returning null when none exist. */
  captureAndSave(
    windowId: WindowId,
    details: TabSetDetails,
  ): Promise<TabSet | null>;

  /** Replaces the window's managed tabs with a saved set. */
  replace(windowId: WindowId, setId: TabSetId): Promise<string[]>;

  /** Adds a saved set to the window without replacing existing tabs. */
  append(windowId: WindowId, setId: TabSetId): Promise<string[]>;

  /** Removes a saved set's tabs from the window. */
  unload(windowId: WindowId, setId: TabSetId): Promise<string[]>;
}

/** Supplies storage, browser, and window integrations used by the controller. */
export interface TabSetControllerDependencies {
  tabSets: TabSets;
  windowSessions: WindowSessions;
  shortcutAssignments: ShortcutAssignments;
  windowTabState: WindowTabState;

  /** Resolves the window associated with the current controller request. */
  getCurrentWindowId(): Promise<WindowId>;

  /** Resolves the most recently focused window, if one is available. */
  getLastFocusedWindowId(): Promise<WindowId | null | undefined>;

  /** Lists browser commands available for shortcut assignment. */
  listBrowserCommands(): Promise<BrowserCommand[]>;
}

/** Wraps an operation failure with context describing the attempted command. */
function commandError(command: string, cause: unknown): Error {
  return new Error(`Failed to ${command}: ${errorMessage(cause)}`, { cause });
}

/** Coordinates tab-set commands and converts failures into command results. */
export class TabSetController {
  readonly #dependencies: TabSetControllerDependencies;

  /** Creates a controller backed by the provided browser and storage services. */
  constructor(dependencies: TabSetControllerDependencies) {
    this.#dependencies = dependencies;
  }

  /** Loads the popup state for the current window. */
  getPopupState() {
    return this.#execute('load popup state', async () => {
      const windowId = await this.#dependencies.getCurrentWindowId();
      return { state: await this.#popupState(windowId) };
    });
  }

  /** Captures pinned tabs and refreshes popup state, failing when none are found. */
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

  /** Replaces the current window's managed tabs and refreshes popup state. */
  loadSet(setId: TabSetId) {
    return this.#updatePopupState('load tab set', setId, 'replace');
  }

  /** Appends a saved set to the current window and refreshes popup state. */
  appendSet(setId: TabSetId) {
    return this.#updatePopupState('append tab set', setId, 'append');
  }

  /** Removes a saved set from the current window and refreshes popup state. */
  unloadSet(setId: TabSetId) {
    return this.#updatePopupState('unload tab set', setId, 'unload');
  }

  /** Deletes a saved set and refreshes popup state for the current window. */
  deleteSet(setId: TabSetId) {
    return this.#execute('delete tab set', async () => {
      const windowId = await this.#dependencies.getCurrentWindowId();
      await this.#dependencies.tabSets.remove(setId);
      return { state: await this.#popupState(windowId) };
    });
  }

  /** Enables or disables autoload for a set while preserving the configured scope. */
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

  /** Loads tab sets, shortcut assignments, and available browser commands. */
  getOptionsState() {
    return this.#execute('load options state', async () => ({
      state: await this.#optionsState(),
    }));
  }

  /** Assigns a command to a tab set and refreshes options state. */
  assignShortcut(command: string, setId: TabSetId) {
    return this.#execute('assign keyboard shortcut', async () => {
      await this.#dependencies.shortcutAssignments.assign(command, setId);
      return { state: await this.#optionsState() };
    });
  }

  /** Exports all tab-set data as a command result. */
  exportSets() {
    return this.#execute(
      'export tab sets',
      () => this.#dependencies.tabSets.export(),
    );
  }

  /** Imports validated tab sets and returns their count with refreshed options state. */
  importSets(document: unknown) {
    return this.#execute('import tab sets', async () => {
      const imported = await this.#dependencies.tabSets.import(document);
      return {
        importedCount: imported.length,
        state: await this.#optionsState(),
      };
    });
  }

  /** Runs an assigned command in the last focused window when both are available. */
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

  /** Applies a tab-set operation to the current window and refreshes popup state. */
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

  /** Builds popup state for a window from saved sets, session data, and autoload settings. */
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

  /** Builds options state from saved sets, assignments, and browser commands. */
  async #optionsState(): Promise<OptionsState> {
    const [sets, assignments, commands] = await Promise.all([
      this.#dependencies.tabSets.list(),
      this.#dependencies.shortcutAssignments.list(),
      this.#dependencies.listBrowserCommands(),
    ]);
    return { sets, assignments, commands };
  }

  /** Executes an operation and converts thrown or rejected failures into an error result. */
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