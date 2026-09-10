function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const fallbackLocks = new Map();

function requestLock(name, operation) {
  if (globalThis.navigator?.locks) {
    return globalThis.navigator.locks.request(name, operation);
  }

  const previous = fallbackLocks.get(name) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  fallbackLocks.set(name, current);
  return current.finally(() => {
    if (fallbackLocks.get(name) === current) fallbackLocks.delete(name);
  });
}

export function runWindowOperation(windowId, operation) {
  return requestLock(`pinned-tabs-${windowId}`, operation);
}

export function setActiveTabSet(browser, windowId, setId) {
  return requestLock('active-tab-sets', async () => {
    const { activeTabs = {} } = await browser.storage.local.get('activeTabs');
    activeTabs[windowId] = setId;
    await browser.storage.local.set({ activeTabs });
  });
}

function effectiveUrl(tab) {
  return tab.pendingUrl || tab.url;
}

function tabsMatch(currentTabs, savedUrls) {
  return currentTabs.length === savedUrls.length
    && currentTabs.every((tab, index) => effectiveUrl(tab) === savedUrls[index]);
}

async function createPinnedTab(browser, windowId, url) {
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

async function replacePinnedTabs(browser, windowId, currentTabs, savedUrls) {
  const tabIds = currentTabs.map((tab) => tab.id);
  if (tabIds.length > 0) await browser.tabs.remove(tabIds);

  for (const url of savedUrls) {
    await createPinnedTab(browser, windowId, url);
  }
}

export function loadTabSet(browser, setId, windowId) {
  return runWindowOperation(windowId, async () => {
    const [currentTabs, sets] = await Promise.all([
      browser.tabs.query({ pinned: true, windowId }),
      browser.storage.sync.get(setId),
    ]);
    const set = sets[setId];
    if (!set) throw new Error(`Tab set ${setId} does not exist`);

    await replacePinnedTabs(browser, windowId, currentTabs, set.tabs);
    await setActiveTabSet(browser, windowId, setId);
  });
}

export function appendTabSet(browser, setId, windowId) {
  return runWindowOperation(windowId, async () => {
    const [currentTabs, sets] = await Promise.all([
      browser.tabs.query({ pinned: true, windowId }),
      browser.storage.sync.get(setId),
    ]);
    const set = sets[setId];
    if (!set) throw new Error(`Tab set ${setId} does not exist`);

    const existingUrls = new Map();
    for (const tab of currentTabs) {
      const url = effectiveUrl(tab);
      existingUrls.set(url, (existingUrls.get(url) ?? 0) + 1);
    }
    await setActiveTabSet(browser, windowId, null);
    for (const url of set.tabs) {
      const remaining = existingUrls.get(url) ?? 0;
      if (remaining > 0) {
        existingUrls.set(url, remaining - 1);
      } else {
        await createPinnedTab(browser, windowId, url);
      }
    }
  });
}

export function restoreAutoloadSet(browser, windowId) {
  return runWindowOperation(windowId, async () => {
    const [currentTabs, sets] = await Promise.all([
      browser.tabs.query({ pinned: true, windowId }),
      browser.storage.sync.get(null),
    ]);
    const entry = Object.entries(sets).find(([, set]) => set.autoload == 1);

    if (!entry) {
      await setActiveTabSet(browser, windowId, null);
      return;
    }

    const [setId, set] = entry;
    if (!tabsMatch(currentTabs, set.tabs)) {
      await replacePinnedTabs(browser, windowId, currentTabs, set.tabs);
    }
    await setActiveTabSet(browser, windowId, setId);
  });
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
