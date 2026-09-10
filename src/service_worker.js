import { Autoload } from './functions.js';
import { registerShortcuts } from './shortcuts.mjs';

var browser = globalThis.browser ?? globalThis.chrome;
registerShortcuts(browser);

export async function handleStartup() {
  await browser.storage.local.remove('activeTabs');

  if (!browser.windows.onCreated.hasListener(Autoload.windowCreated)) {
    browser.windows.onCreated.addListener(Autoload.windowCreated);
  }

  // Workaround:
  //  browser.windows.onCreated does not consistently fire in all browsers
  //  on the first window launched
  return Autoload.manual();
}

browser.runtime.onStartup.addListener(handleStartup);