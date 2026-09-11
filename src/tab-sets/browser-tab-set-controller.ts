import type {
  AutoloadScope,
  BrowserCommand,
  ExportDocument,
} from '../domain.js';
import { createBrowserRepositories } from '../storage/browser-repositories.js';
import { TabSetController } from './tab-set-controller.js';
import { createWindowTabStateClient } from '../storage/window-tab-state.js';

type BrowserRepositoriesApi =
  Parameters<typeof createBrowserRepositories>[0];

type WindowTabStateBrowserApi =
  Parameters<typeof createWindowTabStateClient>[0];

type ControllerDependencies =
  ConstructorParameters<typeof TabSetController>[0];

type CurrentWindowId = Awaited<
  ReturnType<ControllerDependencies['getCurrentWindowId']>
>;

type LastFocusedWindowId = Awaited<
  ReturnType<ControllerDependencies['getLastFocusedWindowId']>
>;

interface BrowserApi {
  windows: {
    getCurrent(): Promise<{
      id?: CurrentWindowId;
    }>;
    getLastFocused(options: {
      windowTypes: ['normal'];
    }): Promise<
      | {
          id?: LastFocusedWindowId;
        }
      | null
      | undefined
    >;
  };
  commands: {
    getAll(): Promise<BrowserCommand[]>;
  };
}

type BrowserTabSetControllerApi =
  & BrowserApi
  & BrowserRepositoriesApi
  & WindowTabStateBrowserApi;

interface BrowserTabSetControllerOptions {
  windowTabState?: ReturnType<typeof createWindowTabStateClient>;
}

export function createBrowserTabSetController(
  browser: BrowserTabSetControllerApi,
  {
    windowTabState = createWindowTabStateClient(browser),
  }: BrowserTabSetControllerOptions = {},
): TabSetController<ExportDocument, BrowserCommand, AutoloadScope> {
  const repositories = createBrowserRepositories(browser);
  const browserApi: BrowserApi = browser;

  return new TabSetController({
    ...repositories,
    windowTabState,
    async getCurrentWindowId() {
      const { id } = await browserApi.windows.getCurrent();

      if (id === undefined) {
        throw new Error('The current browser window has no id');
      }

      return id;
    },
    async getLastFocusedWindowId() {
      const window = await browserApi.windows.getLastFocused({
        windowTypes: ['normal'],
      });
      return window?.id;
    },
    listBrowserCommands() {
      return browserApi.commands.getAll();
    },
  });
}