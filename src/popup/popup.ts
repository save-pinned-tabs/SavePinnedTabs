import { selectBrowserApi } from '../browser-api.js';
import { createBrowserTabSetController } from '../tab-sets/browser-tab-set-controller.js';
import { startPopupApp } from './popup-app.js';
import { createPopupUi } from './popup-ui.js';

type BrowserApi = Parameters<typeof createBrowserTabSetController>[0];
type PopupController = ReturnType<typeof createBrowserTabSetController>;

declare global {
  interface Window {
    browser?: BrowserApi;
    chrome: BrowserApi;
    savePinnedTabsController?: PopupController;
  }
}

const browser = selectBrowserApi(window.browser, window.chrome);
const controller = createBrowserTabSetController(browser);

if (navigator.webdriver) {
  window.savePinnedTabsController = controller;
}

startPopupApp(controller, createPopupUi(document));