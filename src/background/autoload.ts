import type { TabSet } from '../domain.js';
import { createBrowserRepositories } from '../storage/browser-repositories.js';
import {
  createBrowserWindowTabState,
  type WindowTabState,
} from '../storage/window-tab-state.js';

interface PermissionsApi {
  contains(details: { permissions: string[] }): Promise<boolean>;
}

interface RuntimeApi {
  readonly getURL?: (path: string) => string;
}

interface BrowserApi {
  readonly permissions?: PermissionsApi;
  readonly runtime?: RuntimeApi;
}

interface FaviconResponse {
  readonly ok: boolean;
  arrayBuffer(): Promise<unknown>;
}

type FaviconFetch = (url: URL) => Promise<FaviconResponse>;
type BrowserRepositoriesApi = Parameters<typeof createBrowserRepositories>[0];
type BrowserWindowTabStateApi = Parameters<typeof createBrowserWindowTabState>[0];
type WindowStateBrowserApi = BrowserApi & BrowserWindowTabStateApi;
type AutoloadBrowserApi = WindowStateBrowserApi & BrowserRepositoriesApi;
type TabSetId = TabSet['id'];
type WindowId = Parameters<WindowTabState['replace']>[0];
type AutoloadConfiguration = Awaited<
  ReturnType<
    ReturnType<typeof createBrowserRepositories>['tabSets']['getAutoload']
  >
>;

async function hasFaviconPermission(browser: BrowserApi): Promise<boolean> {
  try {
    return (
      await browser.permissions?.contains({ permissions: ['favicon'] })
    ) ?? false;
  } catch {
    return false;
  }
}

export async function preloadFavicons(
  browser: BrowserApi,
  urls: readonly string[],
  fetchFavicon: FaviconFetch = fetch,
): Promise<void> {
  const getUrl = browser.runtime?.getURL;
  if (!getUrl || !await hasFaviconPermission(browser)) return;

  await Promise.all(urls.map(async (url) => {
    const faviconUrl = new URL(getUrl('/_favicon/'));
    faviconUrl.searchParams.set('pageUrl', url);
    faviconUrl.searchParams.set('size', '32');

    try {
      const response = await fetchFavicon(faviconUrl);
      if (response.ok) await response.arrayBuffer();
    } catch {
      // Favicon loading is opportunistic and must not block tab restoration.
    }
  }));
}

export async function loadTabSet(
  browser: WindowStateBrowserApi,
  setId: TabSetId,
  windowId: WindowId,
): Promise<void> {
  const windowTabState = createBrowserWindowTabState(browser, {
    onReplace(urls) {
      void preloadFavicons(browser, urls);
    },
  });
  await windowTabState.replace(windowId, setId);
}

export async function appendTabSet(
  browser: WindowStateBrowserApi,
  setId: TabSetId,
  windowId: WindowId,
): Promise<void> {
  const windowTabState = createBrowserWindowTabState(browser);
  await windowTabState.append(windowId, setId);
}

export async function unloadTabSet(
  browser: WindowStateBrowserApi,
  setId: TabSetId,
  windowId: WindowId,
): Promise<void> {
  const windowTabState = createBrowserWindowTabState(browser);
  await windowTabState.unload(windowId, setId);
}

export async function restoreAutoloadSets(
  browser: AutoloadBrowserApi,
  windowId: WindowId,
  configuration: AutoloadConfiguration,
  windowTabState: WindowTabState = createBrowserWindowTabState(browser, {
    onReplace(urls) {
      void preloadFavicons(browser, urls);
    },
  }),
): Promise<void> {
  if (configuration.setIds.length === 0) {
    await windowTabState.deactivate(windowId);
    return;
  }

  const repositories = createBrowserRepositories(browser);
  const storedSetIds = new Set(
    (await repositories.tabSets.list()).map((set) => set.id),
  );
  const setIds = configuration.setIds.filter((setId) =>
    storedSetIds.has(setId)
  );

  if (setIds.length === 0) {
    await windowTabState.deactivate(windowId);
    return;
  }

  let replace = true;
  for (const setId of setIds) {
    if (replace) {
      await windowTabState.replace(windowId, setId);
      replace = false;
    } else {
      await windowTabState.append(windowId, setId);
    }
  }
}

export async function restoreAutoloadSet(
  browser: AutoloadBrowserApi,
  windowId: WindowId,
  windowTabState?: WindowTabState,
): Promise<void> {
  const configuration =
    await createBrowserRepositories(browser).tabSets.getAutoload();
  return restoreAutoloadSets(
    browser,
    windowId,
    configuration,
    windowTabState,
  );
}