/**
 * Restores configured tab sets and opportunistically preloads their favicons.
 */

import type { BrowserApi } from '../browser-api.js';
import type {
  AutoloadConfiguration,
  TabSetId,
  WindowId,
} from '../domain.js';
import { createBrowserRepositories } from '../storage/browser-repositories.js';
import { createBrowserWindowTabState } from '../storage/window-tab-state.js';

/** Defines the response capabilities needed to preload a favicon. */
interface FaviconResponse {
  readonly ok: boolean;
  arrayBuffer(): Promise<unknown>;
}


/** Fetches a favicon resource for cache warming. */
type FaviconFetch = (url: URL) => Promise<FaviconResponse>;

/** Provides tab-set restoration operations for a browser window. */
export interface AutoloadWindowTabState {
  replace(windowId: WindowId, setId: TabSetId): unknown;
  deactivate(windowId: WindowId): unknown;
}

/** Checks favicon access and treats unavailable or failed permission checks as denied. */
async function hasFaviconPermission(browser: BrowserApi): Promise<boolean> {
  try {
    return (
      await browser.permissions?.contains({ permissions: ['favicon'] })
    ) ?? false;
  } catch {
    return false;
  }
}

/** Warms the browser favicon cache without propagating loading failures. */
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


/** Restores the first existing configured set. */
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

  const selectedSetId = setIds[0];
  if (selectedSetId === undefined) {
    await windowTabState.deactivate(windowId);
    return;
  }

  await windowTabState.replace(windowId, selectedSetId);
}
