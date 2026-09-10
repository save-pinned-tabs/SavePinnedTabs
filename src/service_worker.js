import { Autoload } from './functions.js';
import { registerCommands } from './commands.mjs';
import {
  createBrowserWindowTabState,
  registerWindowTabStateMessages,
} from './window-tab-state.mjs';

var browser = globalThis.browser ?? globalThis.chrome;
var windowTabState = createBrowserWindowTabState(browser);
registerWindowTabStateMessages(browser, windowTabState);
registerCommands(browser, windowTabState);

export async function handleWindowRemoved(windowId) {
  await windowTabState.deactivate(windowId);
}

if (!browser.windows.onRemoved.hasListener(handleWindowRemoved)) {
  browser.windows.onRemoved.addListener(handleWindowRemoved);
}

export async function handleStartup() {
  await windowTabState.resetSessions();

  if (!browser.windows.onCreated.hasListener(Autoload.windowCreated)) {
    browser.windows.onCreated.addListener(Autoload.windowCreated);
  }

  // Workaround:
  //  browser.windows.onCreated does not consistently fire in all browsers
  //  on the first window launched
  return Autoload.manual();
}

browser.runtime.onStartup.addListener(handleStartup);