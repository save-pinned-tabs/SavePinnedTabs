import {
  BrowserTabSetStorage,
  TabSetRepository,
} from '../tab-sets/tab-set-repository.mjs';
import {
  BrowserReferenceStorage,
  BrowserStorageMigration,
} from './storage-schema.mjs';
import {
  ShortcutAssignmentRepository,
  ShortcutAssignmentStorage,
} from './shortcut-assignment-repository.mjs';
import {
  BrowserWindowSessionStorage,
  WindowSessionRepository,
} from './window-session-repository.mjs';

const repositoriesByBrowser = new WeakMap();

export function createBrowserRepositories(browser) {
  const cached = repositoriesByBrowser.get(browser);
  if (cached) return cached;

  const migration = new BrowserStorageMigration(
    browser.storage.sync,
    browser.storage.local,
  );
  const referenceStorage = new BrowserReferenceStorage(browser.storage.local, migration);
  const windowSessions = new WindowSessionRepository(
    new BrowserWindowSessionStorage(referenceStorage),
  );
  let tabSets;
  const shortcutAssignments = new ShortcutAssignmentRepository(
    new ShortcutAssignmentStorage(referenceStorage),
    { hasSet: (setId) => tabSets.get(setId) },
  );
  tabSets = new TabSetRepository(
    new BrowserTabSetStorage(browser.storage.sync, migration),
    {
      validateImport(document) {
        return typeof globalThis.validate20 === 'function' && globalThis.validate20(document);
      },
      windowSessions,
      shortcutAssignments,
    },
  );

  const repositories = { tabSets, windowSessions, shortcutAssignments };
  repositoriesByBrowser.set(browser, repositories);
  return repositories;
}
