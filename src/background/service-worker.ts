/** Initializes the background service worker and connects browser lifecycle, tab state, and command handlers. */

import {
  selectBrowserApi,
  type BrowserApi,
  type BrowserWindow,
} from '../browser-api.js';
import { preloadFavicons } from './autoload.js';
import { createBrowserLifecycle } from './browser-lifecycle.js';
import { createBrowserTabSetController } from '../tab-sets/browser-tab-set-controller.js';
import { registerCommands } from './commands.js';
import {
  createBrowserWindowTabState,
  registerWindowTabStateMessages,
} from '../storage/window-tab-state.js';

declare global {
  var browser: BrowserApi | undefined;
  var chrome: BrowserApi;
  var savePinnedTabsCommandListener: (command: string) => Promise<unknown>;
}

const browser = selectBrowserApi({
  browser: globalThis.browser,
  chrome: globalThis.chrome,
});
const windowTabState = createBrowserWindowTabState(browser, {
  onReplace(urls) {
    void preloadFavicons(browser, urls);
  },
});
const tabSetController = createBrowserTabSetController(browser, {
  windowTabState,
});
const browserLifecycle = createBrowserLifecycle(browser, {
  windowTabState,
});

registerWindowTabStateMessages(browser, windowTabState);
globalThis.savePinnedTabsCommandListener = registerCommands(
  browser,
  tabSetController,
);

/** Restores managed browser state when the browser starts. */
export function handleStartup() {
  return browserLifecycle.onBrowserStartup();
}

browser.runtime.onStartup.addListener(handleStartup);
browser.windows.onCreated.addListener((window: BrowserWindow) =>
  browserLifecycle.onWindowCreated(window),
);
browser.windows.onRemoved.addListener((windowId: number) =>
  browserLifecycle.onWindowRemoved(windowId),
);
export const startupInitialization = handleStartup();