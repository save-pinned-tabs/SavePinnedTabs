import { selectBrowserApi, type BrowserApi } from '../browser-api.js';
import { createBrowserTabSetController } from '../tab-sets/browser-tab-set-controller.js';
import type { TabSetController } from '../tab-sets/tab-set-controller.js';
import { startPopupApp } from './popup-app.js';
import { createPopupUi } from './popup-ui.js';


declare global {
  interface Window {
    browser?: BrowserApi;
    chrome: BrowserApi;
    savePinnedTabsController?: TabSetController;
  }
}

const browser = selectBrowserApi({
  browser: window.browser,
  chrome: window.chrome,
});
const controller = createBrowserTabSetController(browser);

if (navigator.webdriver) {
  window.savePinnedTabsController = controller;
}

startPopupApp(controller, createPopupUi(document));