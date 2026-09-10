import { Autoload } from './functions.js';
import { createBrowserRepositories } from './repositories.mjs';

var browser = globalThis.browser ?? globalThis.chrome;
var repositories = createBrowserRepositories(browser);

export async function handleWindowRemoved(windowId) {
  await repositories.windowSessions.clearClosedWindow(windowId);
}

if (!browser.windows.onRemoved.hasListener(handleWindowRemoved)) {
  browser.windows.onRemoved.addListener(handleWindowRemoved);
}

export async function handleStartup() {
  await repositories.windowSessions.clearAll();

  if (!browser.windows.onCreated.hasListener(Autoload.windowCreated)) {
    browser.windows.onCreated.addListener(Autoload.windowCreated);
  }

  // Workaround:
  //  browser.windows.onCreated does not consistently fire in all browsers
  //  on the first window launched
  return Autoload.manual();
}

browser.runtime.onStartup.addListener(handleStartup);