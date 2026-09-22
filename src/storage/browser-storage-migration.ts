/** Orchestrates restart-safe conversion of historical browser storage. */

import type { BrowserStorageArea } from '../browser-api.js';
import {
  convertLegacyLocalDocument,
  legacySetEntries,
  LEGACY_SESSIONS_KEY,
  OBSOLETE_LOCAL_REFERENCES_KEY,
  recoverSyncDocument,
} from './legacy-storage.js';
import {
  createSerializedStorageOperation,
  type SerializedOperation,
} from './serialized-operation.js';
import {
  LOCAL_DOCUMENT_KEY,
  newSetId,
  parseLocalDocument,
  parseSyncDocument,
  SYNC_DOCUMENT_KEY,
  type StorageMigration,
  type SyncDocument,
} from './storage-schema.js';
import {
  SYNC_INDEX_KEY,
  SyncDocumentStorage,
} from './sync-document-storage.js';

/** Serializes migration across extension contexts. */
const MIGRATION_LOCK = 'save-pinned-tabs:schema-migration';

/** Keeps recovered sync data durable while quota-bound records are replaced. */
const MIGRATION_STAGING_KEY = 'savePinnedTabs:migration-staging';

/** Configures identifier generation during historical conversion. */
export interface MigrationOptions {
  /** Supplies candidate UUIDs, primarily for deterministic migration. */
  createId?: () => string;
}

/** Removes storage entries when at least one key is present. */
async function removeKeys(
  storage: BrowserStorageArea,
  keys: string[],
): Promise<void> {
  if (keys.length > 0) await storage.remove(keys);
}

/** Migrates synchronized and local browser storage to the current schema. */
export class BrowserStorageMigration implements StorageMigration {
  /** Generates identifiers for migrated historical sets. */
  #createId: () => string;

  /** Serializes migration work across extension contexts. */
  #runExclusive: SerializedOperation;

  /** Caches the active or completed migration attempt. */
  #migration: Promise<void> | undefined;

  /** Creates a migration coordinator for the supplied storage areas. */
  constructor(
    private readonly syncStorage: BrowserStorageArea,
    private readonly localStorage: BrowserStorageArea,
    { createId = newSetId }: MigrationOptions = {},
  ) {
    this.#createId = createId;
    this.#runExclusive = createSerializedStorageOperation(
      localStorage,
      MIGRATION_LOCK,
    );
  }

  /** Runs migration once, shares concurrent work, and permits retry after failure. */
  ensureMigrated(): Promise<void> {
    const currentMigration = this.#migration;
    if (currentMigration) return currentMigration;

    const migration = this.#runExclusive(() => this.#migrate())
      .catch((error: unknown) => {
        this.#migration = undefined;
        throw error;
      });

    this.#migration = migration;
    return migration;
  }

  /** Recovers every valid source, commits a verified generation, then cleans up. */
  async #migrate(): Promise<void> {
    const [storedSync, storedLocal] = await Promise.all([
      this.syncStorage.get(null),
      this.localStorage.get(null),
    ]);
    const documents = new SyncDocumentStorage(this.syncStorage);
    let active: SyncDocument | null = null;
    try {
      active = documents.readSnapshot(storedSync);
    } catch {
      // An invalid or incomplete generation is not allowed to hide old sources.
    }

    let staged: SyncDocument | null = null;
    if (storedLocal[MIGRATION_STAGING_KEY] !== undefined) {
      try {
        staged = parseSyncDocument(storedLocal[MIGRATION_STAGING_KEY]);
      } catch {
        // Invalid staging data cannot supersede recoverable synchronized data.
      }
    }
    let monolithic: SyncDocument | null = null;
    if (storedSync[SYNC_DOCUMENT_KEY] !== undefined) {
      try {
        monolithic = parseSyncDocument(storedSync[SYNC_DOCUMENT_KEY]);
      } catch {
        // Invalid monolithic data is independent from other recovery sources.
      }
    }
    const historicalEntries = legacySetEntries(
      storedSync,
      new Set([SYNC_DOCUMENT_KEY, SYNC_INDEX_KEY]),
    );
    const hasRecoverySources = staged !== null
      || monolithic !== null
      || historicalEntries.length > 0;

    if (!active && !hasRecoverySources) {
      const hasInvalidSource = SYNC_INDEX_KEY in storedSync
        || SYNC_DOCUMENT_KEY in storedSync;
      if (hasInvalidSource) {
        throw new Error('No valid synchronized storage source is available');
      }
    }
    const syncDocument = recoverSyncDocument(
      active,
      staged ?? monolithic,
      historicalEntries,
      this.#createId,
    );

    const storedLocalDocument = storedLocal[LOCAL_DOCUMENT_KEY];
    const localDocument = storedLocalDocument === undefined
      ? convertLegacyLocalDocument(storedLocal, syncDocument)
      : parseLocalDocument(
          storedLocalDocument,
          new Set(Object.keys(syncDocument.sets)),
        );
    const localChanged = storedLocalDocument === undefined
      || JSON.stringify(localDocument) !== JSON.stringify(storedLocalDocument);

    const obsoleteSyncKeys = historicalEntries.map(([key]) => key).concat(
      monolithic ? [SYNC_DOCUMENT_KEY] : [],
    );
    if (hasRecoverySources) {
      await this.localStorage.set({
        [MIGRATION_STAGING_KEY]: syncDocument,
      });
      await documents.removeGenerations();
      await removeKeys(this.syncStorage, obsoleteSyncKeys);
      await documents.save(syncDocument);
    } else if (!active) {
      await documents.save(syncDocument);
    }

    if (localChanged) {
      await this.localStorage.set({
        [LOCAL_DOCUMENT_KEY]: localDocument,
      });
    }

    await removeKeys(this.localStorage, [
      MIGRATION_STAGING_KEY,
      ...[LEGACY_SESSIONS_KEY, OBSOLETE_LOCAL_REFERENCES_KEY]
        .filter((key) => key in storedLocal),
    ]);
  }
}
