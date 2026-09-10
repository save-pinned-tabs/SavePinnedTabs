import { createBrowserRepositories } from '../storage/browser-repositories.mjs';
import { createBrowserWindowTabState } from '../storage/window-tab-state.mjs';

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

export async function restoreAutoloadSets(
  browser,
  windowId,
  configuration,
  windowTabState = createBrowserWindowTabState(browser, {
    onReplace(urls) {
      void preloadFavicons(browser, urls);
    },
  }),
) {
  if (configuration.setIds.length === 0) {
    await windowTabState.deactivate(windowId);
    return;
  }

  const repositories = createBrowserRepositories(browser);
  const setsById = new Map((await repositories.tabSets.list()).map((set) => [set.id, set]));
  const setIds = configuration.setIds.filter((setId) => setsById.has(setId));
  if (setIds.length === 0) {
    await windowTabState.deactivate(windowId);
    return;
  }

  await windowTabState.replace(windowId, setIds[0]);
  for (const setId of setIds.slice(1)) await windowTabState.append(windowId, setId);
}

export async function restoreAutoloadSet(browser, windowId, windowTabState) {
  const configuration = await createBrowserRepositories(browser).tabSets.getAutoload();
  return restoreAutoloadSets(browser, windowId, configuration, windowTabState);
}
