function commandError(command, cause) {
  return new Error(`Failed to ${command}: ${cause.message}`, { cause });
}

function success(value) {
  return { status: 'success', value };
}

function failure(command, error) {
  return { status: 'error', error: commandError(command, error) };
}

export class TabSetController {
  #tabSets;
  #windowSessions;
  #shortcutAssignments;
  #windowTabState;
  #getCurrentWindowId;
  #getLastFocusedWindowId;
  #listBrowserCommands;

  constructor({
    tabSets,
    windowSessions,
    shortcutAssignments,
    windowTabState,
    getCurrentWindowId,
    getLastFocusedWindowId,
    listBrowserCommands,
  }) {
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

  saveSet(name, setId) {
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

  loadSet(setId) {
    return this.#execute('load tab set', async () => {
      const windowId = await this.#getCurrentWindowId();
      await this.#windowTabState.replace(windowId, setId);
      return { state: await this.#popupState(windowId) };
    });
  }

  appendSet(setId) {
    return this.#execute('append tab set', async () => {
      const windowId = await this.#getCurrentWindowId();
      await this.#windowTabState.append(windowId, setId);
      return { state: await this.#popupState(windowId) };
    });
  }

  unloadSet(setId) {
    return this.#execute('unload tab set', async () => {
      const windowId = await this.#getCurrentWindowId();
      await this.#windowTabState.unload(windowId, setId);
      return { state: await this.#popupState(windowId) };
    });
  }

  deleteSet(setId) {
    return this.#execute('delete tab set', async () => {
      const windowId = await this.#getCurrentWindowId();
      await this.#tabSets.remove(setId);
      return { state: await this.#popupState(windowId) };
    });
  }

  setAutoload(setId, enabled) {
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

  assignShortcut(command, setId) {
    return this.#execute('assign keyboard shortcut', async () => {
      await this.#shortcutAssignments.assign(command, setId);
      return { state: await this.#optionsState() };
    });
  }

  exportSets() {
    return this.#execute('export tab sets', () => this.#tabSets.export());
  }

  importSets(document) {
    return this.#execute('import tab sets', async () => {
      const imported = await this.#tabSets.import(document);
      return {
        importedCount: imported.length,
        state: await this.#optionsState(),
      };
    });
  }

  runShortcut(command) {
    return this.#execute(`run tab-set command "${command}"`, async () => {
      const setId = (await this.#shortcutAssignments.list())[command];
      if (!setId) return { executed: false };

      const windowId = await this.#getLastFocusedWindowId();
      if (windowId === null || windowId === undefined) return { executed: false };
      await this.#windowTabState.replace(windowId, setId);
      return { executed: true };
    });
  }

  async #popupState(windowId) {
    const [sets, activeSetId, autoload] = await Promise.all([
      this.#tabSets.list(),
      this.#windowSessions.get(windowId),
      this.#tabSets.getAutoload(),
    ]);
    return {
      sets,
      activeSetId,
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

  async #execute(command, operation) {
    try {
      return success(await operation());
    } catch (error) {
      return failure(command, error);
    }
  }
}
