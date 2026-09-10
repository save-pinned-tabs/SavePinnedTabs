import { createBrowserRepositories } from './repositories.mjs';
import { TabSetController } from './tab-set-controller.mjs';
import { createWindowTabStateClient } from './window-tab-state.mjs';

export function createBrowserTabSetController(browser, {
  windowTabState = createWindowTabStateClient(browser),
} = {}) {
  const repositories = createBrowserRepositories(browser);

  return new TabSetController({
    ...repositories,
    windowTabState,
    async getCurrentWindowId() {
      return (await browser.windows.getCurrent()).id;
    },
    async getLastFocusedWindowId() {
      const window = await browser.windows.getLastFocused({ windowTypes: ['normal'] });
      return window?.id;
    },
    listBrowserCommands() {
      return browser.commands.getAll();
    },
  });
}
