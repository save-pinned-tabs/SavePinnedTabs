import { createBrowserRepositories } from './repositories.mjs';
import { createBrowserWindowTabState } from './window-tab-state.mjs';




async function hasFaviconPermission(browser) {
  try {
    return await browser.permissions?.contains({ permissions: ['favicon'] }) ?? false;
  } catch {
    return false;
  }
}

export async function preloadFavicons(browser, urls, fetchFavicon = fetch) {
  if (!browser.runtime?.getURL || !await hasFaviconPermission(browser)) return;
  await Promise.all(urls.map(async (url) => {
    const faviconUrl = new URL(browser.runtime.getURL('/_favicon/'));
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


export async function loadTabSet(browser, setId, windowId) {
  const windowTabState = createBrowserWindowTabState(browser, {
    onReplace(urls) {
      void preloadFavicons(browser, urls);
    },
  });
  await windowTabState.replace(windowId, setId);
}

export async function appendTabSet(browser, setId, windowId) {
  const windowTabState = createBrowserWindowTabState(browser);
  await windowTabState.append(windowId, setId);
}

export async function unloadTabSet(browser, setId, windowId) {
  const windowTabState = createBrowserWindowTabState(browser);
  await windowTabState.unload(windowId, setId);
}

export async function restoreAutoloadSet(
  browser,
  windowId,
  windowTabState = createBrowserWindowTabState(browser, {
    onReplace(urls) {
      void preloadFavicons(browser, urls);
    },
  }),
) {
  const repositories = createBrowserRepositories(browser);
  const sets = await repositories.tabSets.list();
  const entry = Object.entries(sets).find(([, set]) => set.autoload == 1);

  if (!entry) {
    await windowTabState.deactivate(windowId);
    return;
  }

  await windowTabState.replace(windowId, entry[0]);
}
