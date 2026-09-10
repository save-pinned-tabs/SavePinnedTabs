import { createBrowserRepositories } from './repositories.mjs';

export function createShortcutAssignments(browser) {
  return createBrowserRepositories(browser).shortcutAssignments;
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

export function registerCommands(browser, windowTabState, shortcutAssignments) {
  const handleCommand = createCommandHandler(browser, windowTabState, shortcutAssignments);
  browser.commands.onCommand.addListener((command) => {
    handleCommand(command).catch(console.error);
  });
}
