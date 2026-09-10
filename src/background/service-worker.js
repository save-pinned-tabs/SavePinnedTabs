import { preloadFavicons } from './autoload.mjs';
import { createBrowserLifecycle } from './browser-lifecycle.mjs';
import { createBrowserTabSetController } from '../tab-sets/browser-tab-set-controller.mjs';
import { registerCommands } from './commands.mjs';
import {
  createBrowserWindowTabState,
  registerWindowTabStateMessages,
} from '../storage/window-tab-state.mjs';

const browser = globalThis.browser ?? globalThis.chrome;
const windowTabState = createBrowserWindowTabState(browser, {
  onReplace(urls) {
    void preloadFavicons(browser, urls);
  },
});
const tabSetController = createBrowserTabSetController(browser, { windowTabState });
const browserLifecycle = createBrowserLifecycle(browser, {
  windowTabState,
});

registerWindowTabStateMessages(browser, windowTabState);
globalThis.savePinnedTabsCommandListener = registerCommands(browser, tabSetController);

export function handleStartup() {
  return browserLifecycle.onBrowserStartup();
}


browser.runtime.onStartup.addListener(handleStartup);
browser.windows.onCreated.addListener((window) => (
  browserLifecycle.onWindowCreated(window)
));
browser.windows.onRemoved.addListener((windowId) => (
  browserLifecycle.onWindowRemoved(windowId)
));