import { createBrowserTabSetController } from './browser-tab-set-controller.mjs';
import { startPopupApp } from './popup-app.mjs';
import { createPopupUi } from './popup-ui.mjs';

const browser = globalThis.browser ?? globalThis.chrome;
const controller = createBrowserTabSetController(browser);
if (navigator.webdriver) globalThis.savePinnedTabsController = controller;
startPopupApp(controller, createPopupUi(document));
