/** Registers browser command listeners and delegates shortcut execution to a controller. */

import type { BrowserApi } from '../browser-api.js';

/** Describes the outcome of executing a shortcut command. */
interface ShortcutResult {
  /** Indicates whether execution succeeded or failed. */
  readonly status: string;
  /** Contains failure details when the status is `error`. */
  readonly error?: unknown;
}

/** Executes shortcut commands and produces a standardized result. */
interface ShortcutController<Result extends ShortcutResult> {
  /** Runs the action associated with a browser command. */
  runShortcut(command: string): Promise<Result>;
}

/** Registers a command listener that logs execution errors and returns each result. */
export function registerCommands<Result extends ShortcutResult>(
  browser: BrowserApi,
  controller: ShortcutController<Result>,
): (command: string) => Promise<Result> {
  /** Delegates a command to the controller and logs reported errors. */
  const listener = async (command: string): Promise<Result> => {
    const result = await controller.runShortcut(command);
    if (result.status === 'error') console.error(result.error);
    return result;
  };

  browser.commands.onCommand.addListener(listener);
  return listener;
}