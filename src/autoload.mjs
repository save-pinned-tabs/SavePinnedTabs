function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function setActiveTabSet(browser, windowId, setId) {
  const { activeTabs = {} } = await browser.storage.local.get('activeTabs');
  activeTabs[windowId] = setId;
  await browser.storage.local.set({ activeTabs });
}

function effectiveUrl(tab) {
  return tab.pendingUrl || tab.url;
}

function tabsMatch(currentTabs, savedUrls) {
  return currentTabs.length === savedUrls.length
    && currentTabs.every((tab, index) => effectiveUrl(tab) === savedUrls[index]);
}

async function replacePinnedTabs(browser, windowId, currentTabs, savedUrls) {
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
  const [currentTabs, sets] = await Promise.all([
    browser.tabs.query({ pinned: true, windowId }),
    browser.storage.sync.get(setId),
  ]);
  const set = sets[setId];
  if (!set) throw new Error(`Tab set ${setId} does not exist`);

  await replacePinnedTabs(browser, windowId, currentTabs, set.tabs);
  await setActiveTabSet(browser, windowId, setId);
}

export async function restoreAutoloadSet(browser, windowId) {
  const [currentTabs, sets] = await Promise.all([
    browser.tabs.query({ pinned: true, windowId }),
    browser.storage.sync.get(null),
  ]);
  const autoloadEntries = Object.entries(sets)
    .filter(([, set]) => set.autoload == 1);

  if (autoloadEntries.length === 0) {
    await setActiveTabSet(browser, windowId, null);
    return;
  }

  const savedUrls = [];
  const seenUrls = new Set();
  for (const [, set] of autoloadEntries) {
    for (const url of set.tabs) {
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      savedUrls.push(url);
    }
  }
  if (!tabsMatch(currentTabs, savedUrls)) {
    await replacePinnedTabs(browser, windowId, currentTabs, savedUrls);
  }
  const activeSetId = autoloadEntries.length === 1 ? autoloadEntries[0][0] : null;
  await setActiveTabSet(browser, windowId, activeSetId);
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
    if (window?.type === 'normal' && !createdNormalWindow) {
      createdNormalWindow = window;
    }
    return restoreOnce();
  }

  function manual() {
    return restoreOnce();
  }

  return { manual, windowCreated };
}
