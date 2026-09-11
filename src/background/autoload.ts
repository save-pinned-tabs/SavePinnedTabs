import type { BrowserApi } from '../browser-api.js';
import type {
  AutoloadConfiguration,
  TabSetId,
  WindowId,
} from '../domain.js';
import { createBrowserRepositories } from '../storage/browser-repositories.js';
import { createBrowserWindowTabState } from '../storage/window-tab-state.js';

interface FaviconResponse {
  readonly ok: boolean;
  arrayBuffer(): Promise<unknown>;
}


type FaviconFetch = (url: URL) => Promise<FaviconResponse>;
export interface AutoloadWindowTabState {
  replace(windowId: WindowId, setId: TabSetId): unknown;
  append(windowId: WindowId, setId: TabSetId): unknown;
  deactivate(windowId: WindowId): unknown;
}

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


export async function restoreAutoloadSets(
  browser: BrowserApi,
  windowId: WindowId,
  configuration: AutoloadConfiguration,
  windowTabState: AutoloadWindowTabState = createBrowserWindowTabState(browser, {
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
