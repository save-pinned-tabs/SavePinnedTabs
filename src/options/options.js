import { createBrowserTabSetController } from '../tab-sets/browser-tab-set-controller.mjs';
import { startOptionsApp } from './options-app.mjs';
import { createOptionsUi } from './options-ui.mjs';

const browser = globalThis.browser ?? globalThis.chrome;
const controller = createBrowserTabSetController(browser);
startOptionsApp(controller, createOptionsUi(document));
