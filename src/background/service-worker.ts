import { selectBrowserApi } from '../browser-api.js';
import { preloadFavicons } from './autoload.js';
import { createBrowserLifecycle } from './browser-lifecycle.js';
import { createBrowserTabSetController } from '../tab-sets/browser-tab-set-controller.js';
import { registerCommands } from './commands.js';
import {
  createBrowserWindowTabState,
  registerWindowTabStateMessages,
} from '../storage/window-tab-state.js';

type ExtensionBrowserBase =
  & Parameters<typeof preloadFavicons>[0]
  & Parameters<typeof createBrowserLifecycle>[0]
  & Parameters<typeof createBrowserTabSetController>[0]
  & Parameters<typeof registerCommands>[0]
  & Parameters<typeof createBrowserWindowTabState>[0]
  & Parameters<typeof registerWindowTabStateMessages>[0];

type BrowserLifecycle = ReturnType<typeof createBrowserLifecycle>;

interface ServiceWorkerEvent<Arguments extends unknown[]> {
  addListener(listener: (...args: Arguments) => void): void;
}

type ExtensionBrowser = ExtensionBrowserBase & {
  runtime: ExtensionBrowserBase['runtime'] & {
    onStartup: ServiceWorkerEvent<
      Parameters<BrowserLifecycle['onBrowserStartup']>
    >;
  };
  windows: ExtensionBrowserBase['windows'] & {
    onCreated: ServiceWorkerEvent<
      Parameters<BrowserLifecycle['onWindowCreated']>
    >;
    onRemoved: ServiceWorkerEvent<
      Parameters<BrowserLifecycle['onWindowRemoved']>
    >;
  };
};

interface ServiceWorkerGlobals {
  browser?: ExtensionBrowser;
  chrome: ExtensionBrowser;
  savePinnedTabsCommandListener: ReturnType<typeof registerCommands>;
}

declare global {
  var browser: ServiceWorkerGlobals['browser'];
  var chrome: ServiceWorkerGlobals['chrome'];
  var savePinnedTabsCommandListener:
    ServiceWorkerGlobals['savePinnedTabsCommandListener'];
}

const browser = selectBrowserApi(globalThis.browser, globalThis.chrome);
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

export function handleStartup() {
  return browserLifecycle.onBrowserStartup();
}

browser.runtime.onStartup.addListener(handleStartup);
browser.windows.onCreated.addListener((
  window: Parameters<BrowserLifecycle['onWindowCreated']>[0],
) => (
  browserLifecycle.onWindowCreated(window)
));
browser.windows.onRemoved.addListener((
  windowId: Parameters<BrowserLifecycle['onWindowRemoved']>[0],
) => (
  browserLifecycle.onWindowRemoved(windowId)
));