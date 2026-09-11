import type { BrowserApi } from '../browser-api.js';
import { createBrowserRepositories } from '../storage/browser-repositories.js';
import {
  createWindowTabStateClient,
  type WindowTabStateClient,
} from '../storage/window-tab-state.js';
import { TabSetController } from './tab-set-controller.js';

interface BrowserTabSetControllerOptions {
  windowTabState?: WindowTabStateClient;
}

export function createBrowserTabSetController(
  browser: BrowserApi,
  {
    windowTabState = createWindowTabStateClient(browser),
  }: BrowserTabSetControllerOptions = {},
): TabSetController {
  const repositories = createBrowserRepositories(browser);

  return new TabSetController({
    ...repositories,
    windowTabState,
    async getCurrentWindowId() {
      const { id } = await browser.windows.getCurrent();

      if (id === undefined) {
        throw new Error('The current browser window has no id');
      }

      return id;
    },
    async getLastFocusedWindowId() {
      const window = await browser.windows.getLastFocused({
        windowTypes: ['normal'],
      });
      return window?.id;
    },
    listBrowserCommands() {
      return browser.commands.getAll();
    },
  });
}