import { selectBrowserApi, type BrowserApi } from '../browser-api.js';
import { createBrowserTabSetController } from '../tab-sets/browser-tab-set-controller.js';
import { startOptionsApp } from './options-app.js';
import { createOptionsUi } from './options-ui.js';

declare const globalThis: {
  readonly browser?: BrowserApi | null;
  readonly chrome: BrowserApi;
};

const browser = selectBrowserApi({
  browser: globalThis.browser,
  chrome: globalThis.chrome,
});
const controller = createBrowserTabSetController(browser);
startOptionsApp(controller, createOptionsUi(document));