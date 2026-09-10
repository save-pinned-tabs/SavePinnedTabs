import {
  BrowserTabSetStorage,
  TabSetRepository,
} from './tab-set-repository.mjs';
import {
  BrowserWindowSessionStorage,
  WindowSessionRepository,
} from './window-session-repository.mjs';

export function createBrowserRepositories(browser) {
  const windowSessions = new WindowSessionRepository(
    new BrowserWindowSessionStorage(browser.storage.local),
  );
  const tabSets = new TabSetRepository(
    new BrowserTabSetStorage(browser.storage.sync),
    {
      validateImport(sets) {
        return typeof globalThis.validate20 === 'function' && globalThis.validate20(sets);
      },
      windowSessions,
    },
  );

  return { tabSets, windowSessions };
}
