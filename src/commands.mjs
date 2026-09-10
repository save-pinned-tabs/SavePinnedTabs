import { createSerializedStorageOperation } from './serialized-operation.mjs';

const SHORTCUT_SETS_KEY = 'shortcutSets';
const SHORTCUT_ASSIGNMENTS_LOCK = 'save-pinned-tabs:shortcut-assignments';

function assignmentError(operation, cause) {
  return new Error(`Failed to ${operation} shortcut assignments: ${cause.message}`, { cause });
}

export function createShortcutAssignments(browser) {
  const storage = browser.storage.local;
  const runExclusive = createSerializedStorageOperation(storage, SHORTCUT_ASSIGNMENTS_LOCK);

  return {
    async list() {
      try {
        const { shortcutSets = {} } = await storage.get(SHORTCUT_SETS_KEY);
        return { ...shortcutSets };
      } catch (error) {
        throw assignmentError('list', error);
      }
    },

    assign(command, setId) {
      return runExclusive(async () => {
        try {
          const { shortcutSets = {} } = await storage.get(SHORTCUT_SETS_KEY);
          if (setId) shortcutSets[command] = setId;
          else delete shortcutSets[command];
          await storage.set({ [SHORTCUT_SETS_KEY]: shortcutSets });
        } catch (error) {
          throw assignmentError(`assign command "${command}"`, error);
        }
      });
    },
  };
}

function commandError(command, cause) {
  return new Error(`Failed to run tab-set command "${command}": ${cause.message}`, { cause });
}

export function createCommandHandler(
  browser,
  windowTabState,
  shortcutAssignments = createShortcutAssignments(browser),
) {
  return async function handleCommand(command) {
    try {
      const setId = (await shortcutAssignments.list())[command];
      if (!setId) return;

      const window = await browser.windows.getLastFocused({ windowTypes: ['normal'] });
      if (!window) return;
      await windowTabState.replace(window.id, setId);
    } catch (error) {
      throw commandError(command, error);
    }
  };
}

export function registerCommands(browser, windowTabState) {
  const handleCommand = createCommandHandler(browser, windowTabState);
  browser.commands.onCommand.addListener((command) => {
    handleCommand(command).catch(console.error);
  });
}
