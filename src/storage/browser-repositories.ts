/** Constructs and caches browser-backed repositories for tab sets and window sessions. */

import type { BrowserApi } from '../browser-api.js';
import type { TabSetImportDocument } from '../tab-sets/tab-set-import.js';
import { TabSetRepository } from '../tab-sets/tab-set-repository.js';
import { BrowserTabSetStorage } from '../tab-sets/tab-set-storage.js';
import {
  BrowserReferenceStorage,
  BrowserStorageMigration,
} from './storage-schema.js';
import {
  BrowserWindowSessionStorage,
  WindowSessionRepository,
} from './window-session-repository.js';

/** Groups repositories that share a browser instance and storage migration. */
interface BrowserRepositories {
  readonly tabSets: TabSetRepository;
  readonly windowSessions: WindowSessionRepository;
}

/** Narrows an unknown value to a valid tab-set import document. */
type ImportValidator = (
  document: unknown,
) => document is TabSetImportDocument;

declare global {
  /** Holds the generated import-schema validator when it has been loaded. */
  var validate20: ImportValidator | undefined;
}

/** Caches one repository group per browser API instance without retaining discarded instances. */
const repositoriesByBrowser = new WeakMap<BrowserApi, BrowserRepositories>();

/** Creates or retrieves repositories that share storage and cross-repository dependencies. */
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

  const tabSets = new TabSetRepository(
    new BrowserTabSetStorage(browser.storage.sync, migration),
    {
      validateImport(document: unknown): document is TabSetImportDocument {
        return (
          typeof globalThis.validate20 === 'function'
          && globalThis.validate20(document)
        );
      },
      windowSessions,
    },
  );

  const repositories = { tabSets, windowSessions };
  repositoriesByBrowser.set(browser, repositories);
  return repositories;
}