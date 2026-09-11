import type { BrowserApi } from '../browser-api.js';
import type { TabSetImportDocument } from '../tab-sets/tab-set-import.js';
import { TabSetRepository } from '../tab-sets/tab-set-repository.js';
import { BrowserTabSetStorage } from '../tab-sets/tab-set-storage.js';
import {
  BrowserReferenceStorage,
  BrowserStorageMigration,
} from './storage-schema.js';
import {
  ShortcutAssignmentRepository,
  ShortcutAssignmentStorage,
} from './shortcut-assignment-repository.js';
import {
  BrowserWindowSessionStorage,
  WindowSessionRepository,
} from './window-session-repository.js';

interface BrowserRepositories {
  readonly tabSets: TabSetRepository;
  readonly windowSessions: WindowSessionRepository;
  readonly shortcutAssignments: ShortcutAssignmentRepository;
}

type ImportValidator = (
  document: unknown,
) => document is TabSetImportDocument;

declare global {
  var validate20: ImportValidator | undefined;
}

const repositoriesByBrowser = new WeakMap<BrowserApi, BrowserRepositories>();

export function createBrowserRepositories(
  browser: BrowserApi,
): BrowserRepositories {
  const cached = repositoriesByBrowser.get(browser);
  if (cached) return cached;

  const migration = new BrowserStorageMigration(
    browser.storage.sync,
    browser.storage.local,
  );
  const referenceStorage = new BrowserReferenceStorage(
    browser.storage.local,
    migration,
  );
  const windowSessions = new WindowSessionRepository(
    new BrowserWindowSessionStorage(referenceStorage),
  );

  let tabSets: TabSetRepository;
  const shortcutAssignments = new ShortcutAssignmentRepository(
    new ShortcutAssignmentStorage(referenceStorage),
    {
      hasSet: async (setId) => (await tabSets.get(setId)) !== null,
    },
  );

  tabSets = new TabSetRepository(
    new BrowserTabSetStorage(browser.storage.sync, migration),
    {
      validateImport(document: unknown): document is TabSetImportDocument {
        return (
          typeof globalThis.validate20 === 'function'
          && globalThis.validate20(document)
        );
      },
      windowSessions,
      shortcutAssignments,
    },
  );

  const repositories = { tabSets, windowSessions, shortcutAssignments };
  repositoriesByBrowser.set(browser, repositories);
  return repositories;
}