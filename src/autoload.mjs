import { createBrowserRepositories } from './repositories.mjs';

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}


function effectiveUrl(tab) {
  return tab.pendingUrl || tab.url;
}

function tabsMatch(currentTabs, savedUrls) {
  return currentTabs.length === savedUrls.length
    && currentTabs.every((tab, index) => effectiveUrl(tab) === savedUrls[index]);
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

async function replacePinnedTabs(browser, windowId, currentTabs, savedUrls) {
  void preloadFavicons(browser, savedUrls);
  const tabIds = currentTabs.map((tab) => tab.id);
  if (tabIds.length > 0) await browser.tabs.remove(tabIds);

  for (const url of savedUrls) {
    try {
      await browser.tabs.create({
        windowId,
        url,
        active: false,
        pinned: true,
      });
    } catch (error) {
      throw new Error(`Failed to restore tab ${url}`, { cause: error });
    }
  }
}

export async function loadTabSet(browser, setId, windowId) {
  const repositories = createBrowserRepositories(browser);
  const [currentTabs, set] = await Promise.all([
    browser.tabs.query({ pinned: true, windowId }),
    repositories.tabSets.get(setId),
  ]);
  if (!set) throw new Error(`Failed to load tab set "${setId}" in window "${windowId}": set does not exist`);

  await replacePinnedTabs(browser, windowId, currentTabs, set.tabs);
  const activated = await repositories.tabSets.activateWindowSession(setId, set, windowId);
  if (!activated) {
    throw new Error(`Failed to load tab set "${setId}" in window "${windowId}": set changed or was deleted while loading`);
  }
}

export async function restoreAutoloadSet(browser, windowId) {
  const repositories = createBrowserRepositories(browser);
  const [currentTabs, sets] = await Promise.all([
    browser.tabs.query({ pinned: true, windowId }),
    repositories.tabSets.list(),
  ]);
  const entry = Object.entries(sets).find(([, set]) => set.autoload == 1);

  if (!entry) {
    await repositories.windowSessions.set(windowId, null);
    return;
  }

  const [setId, set] = entry;
  if (!tabsMatch(currentTabs, set.tabs)) {
    await replacePinnedTabs(browser, windowId, currentTabs, set.tabs);
  }
  const activated = await repositories.tabSets.activateWindowSession(setId, set, windowId);
  if (!activated) {
    throw new Error(`Failed to restore autoload tab set "${setId}" in window "${windowId}": set changed or was deleted while loading`);
  }
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
