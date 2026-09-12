/** Creates a tab-set controller backed by browser APIs and persistent repositories. */

import type { BrowserApi } from '../browser-api.js';
import { createBrowserRepositories } from '../storage/browser-repositories.js';
import {
  createWindowTabStateClient,
  type WindowTabStateClient,
} from '../storage/window-tab-state.js';
import { TabSetController } from './tab-set-controller.js';

/** Configures optional browser controller dependencies. */
interface BrowserTabSetControllerOptions {
  /** Overrides the default browser-backed window tab state client. */
  windowTabState?: WindowTabStateClient;
}

/** Creates a controller bound to the current browser environment. Throws if the current window has no identifier. */
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
  });
}