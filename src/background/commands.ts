import type { BrowserApi } from '../browser-api.js';

interface ShortcutResult {
  readonly status: string;
  readonly error?: unknown;
}

interface ShortcutController<Result extends ShortcutResult> {
  runShortcut(command: string): Promise<Result>;
}

export function registerCommands<Result extends ShortcutResult>(
  browser: BrowserApi,
  controller: ShortcutController<Result>,
): (command: string) => Promise<Result> {
  const listener = async (command: string): Promise<Result> => {
    const result = await controller.runShortcut(command);
    if (result.status === 'error') console.error(result.error);
    return result;
  };

  browser.commands.onCommand.addListener(listener);
  return listener;
}