import { createBrowserRepositories } from './repositories.mjs';
import { createBrowserWindowTabState } from './window-tab-state.mjs';

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}



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

export async function restoreAutoloadSet(browser, windowId) {
  const repositories = createBrowserRepositories(browser);
  const sets = await repositories.tabSets.list();
  const entry = Object.entries(sets).find(([, set]) => set.autoload == 1);
  const windowTabState = createBrowserWindowTabState(browser, {
    onReplace(urls) {
      void preloadFavicons(browser, urls);
    },
  });

  if (!entry) {
    await windowTabState.deactivate(windowId);
    return;
  }

  await windowTabState.replace(windowId, entry[0]);
}

const STARTUP_WINDOW_ATTEMPTS = 100;

export function createStartupAutoload(browser, delay = wait) {
  let restoration;
  let createdNormalWindow;

  async function findStartupWindow() {
    for (let attempt = 0; attempt < STARTUP_WINDOW_ATTEMPTS; attempt += 1) {
      await delay(50);
      if (createdNormalWindow) return createdNormalWindow;

      const windows = await browser.windows.getAll(null);
      const normalWindows = windows.filter((window) => window.type === 'normal');
      if (normalWindows.length === 1) return normalWindows[0];
    }
    return undefined;
  }

  function restoreOnce() {
    if (!restoration) {
      restoration = (async function () {
        const startupWindow = await findStartupWindow();
        if (!startupWindow) {
          restoration = undefined;
          return;
        }
        await restoreAutoloadSet(browser, startupWindow.id);
      })().catch((error) => {
        createdNormalWindow = undefined;
        restoration = undefined;
        throw error;
      });
    }
    return restoration;
  }

  function windowCreated(window) {
    if (window?.type !== 'normal') return;
    if (!createdNormalWindow) createdNormalWindow = window;
    return restoreOnce();
  }

  function manual() {
    return restoreOnce();
  }

  return { manual, windowCreated };
}
