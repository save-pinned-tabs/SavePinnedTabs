import { loadTabSet } from './autoload.mjs';

const SHORTCUT_SETS_KEY = 'shortcutSets';

export function assignShortcut(browser, command, setId) {
  return navigator.locks.request('shortcut-assignments', async () => {
    const { shortcutSets = {} } = await browser.storage.local.get(SHORTCUT_SETS_KEY);
    if (setId) shortcutSets[command] = setId;
    else delete shortcutSets[command];
    await browser.storage.local.set({ shortcutSets });
  });
}

async function clearStaleShortcut(browser, command, staleSetId) {
  await navigator.locks.request('shortcut-assignments', async () => {
    const { shortcutSets = {} } = await browser.storage.local.get(SHORTCUT_SETS_KEY);
    if (shortcutSets[command] !== staleSetId) return;
    delete shortcutSets[command];
    await browser.storage.local.set({ shortcutSets });
  });
}

export function handleShortcut(browser, command) {
  return navigator.locks.request('shortcut-load', async () => {
    const { shortcutSets = {} } = await browser.storage.local.get(SHORTCUT_SETS_KEY);
    const setId = shortcutSets[command];
    if (!setId) return;
    const saved = await browser.storage.sync.get(setId);
    if (!saved[setId]) {
      await clearStaleShortcut(browser, command, setId);
      return;
    }

    const window = await browser.windows.getLastFocused({ windowTypes: ['normal'] });
    if (!window) return;
    await loadTabSet(browser, setId, window.id);
  });
}

export function registerShortcuts(browser) {
  browser.commands.onCommand.addListener((command) => {
    handleShortcut(browser, command).catch(console.error);
  });
}
