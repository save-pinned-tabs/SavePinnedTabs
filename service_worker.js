import { Autoload } from './functions.js';

var browser = chrome;

export function handleStartup() {
  // autoloading tab set
  browser.storage.local.clear();

  if (!browser.windows.onCreated.hasListener(Autoload.windowCreated)) {
    browser.windows.onCreated.addListener(Autoload.windowCreated);
  }

  // Workaround:
  //  browser.windows.onCreated does not consistently fire in all browsers
  //  on the first window launched
  return Autoload.manual();
}

browser.runtime.onStartup.addListener(handleStartup);