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
}

export function createStartupAutoload(browser, delay = wait) {
  let restoration;

  function restoreOnce(windowId) {
    if (!restoration) {
      restoration = restoreAutoloadSet(browser, windowId).catch((error) => {
        restoration = undefined;
        throw error;
      });
    }
    return restoration;
  }

  async function windowCreated(window) {
    const windows = await browser.windows.getAll(null);
    if (windows.length < 2 && window.type === 'normal') {
      return restoreOnce(window.id);
    }
  }

  async function manual() {
    await delay(50);
    const window = await browser.windows.getCurrent();
    return windowCreated(window);
  }

  return { manual, windowCreated };
}
