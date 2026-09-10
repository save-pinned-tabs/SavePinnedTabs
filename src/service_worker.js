import { preloadFavicons } from './autoload.mjs';
import { createBrowserLifecycle } from './browser-lifecycle.mjs';
import { registerCommands } from './commands.mjs';
import {
  createBrowserWindowTabState,
  registerWindowTabStateMessages,
} from './window-tab-state.mjs';

const browser = globalThis.browser ?? globalThis.chrome;
const windowTabState = createBrowserWindowTabState(browser, {
  onReplace(urls) {
    void preloadFavicons(browser, urls);
  },
});
const browserLifecycle = createBrowserLifecycle(browser, {
  windowTabState,
});

registerWindowTabStateMessages(browser, windowTabState);
registerCommands(browser, windowTabState);

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