import { selectBrowserApi } from '../browser-api.js';
import { createBrowserTabSetController } from '../tab-sets/browser-tab-set-controller.js';
import { startOptionsApp } from './options-app.js';
import { createOptionsUi } from './options-ui.js';

type BrowserApi = Parameters<typeof createBrowserTabSetController>[0];

interface BrowserGlobal {
  readonly browser?: BrowserApi | null;
  readonly chrome: BrowserApi;
}

declare const globalThis: BrowserGlobal;

const browser = selectBrowserApi(globalThis.browser, globalThis.chrome);
const controller = createBrowserTabSetController(browser);
startOptionsApp(controller, createOptionsUi(document));