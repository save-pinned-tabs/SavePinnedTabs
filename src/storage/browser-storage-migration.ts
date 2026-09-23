/** Orchestrates restart-safe conversion of historical browser storage. */

import type { BrowserStorageArea } from '../browser-api.js';
import { migrateStorageState } from './migration/migrate-storage-state.js';
import {
  LEGACY_SESSIONS_KEY,
  OBSOLETE_LOCAL_REFERENCES_KEY,
  unversionedSetEntries,
} from './migration/unversioned-records.js';
import {
  createSerializedStorageOperation,
  type SerializedOperation,
} from './serialized-operation.js';
import {
  LOCAL_DOCUMENT_KEY,
  newSetId,
  SYNC_DOCUMENT_KEY,
  type LocalDocument,
  type StorageMigration,
  type SyncDocument,
} from './storage-schema.js';
import {
  AggregateSyncQuotaError,
  SYNC_COMMITTED_CACHE_KEY,
  SYNC_INDEX_KEY,
  SYNC_RECOVERY_KEY,
  SyncDocumentStorage,
} from './sync-document-storage.js';
import {
  parseMigratingSyncDocument,
  parseStoredLocalDocument,
} from './migration/v2-documents.js';

/** Serializes migration across extension contexts. */
const MIGRATION_LOCK = 'save-pinned-tabs:schema-migration';

/** Keeps recovered sync data durable while quota-bound records are replaced. */
const MIGRATION_STAGING_KEY = 'savePinnedTabs:migration-staging';

/** Keeps converted local references durable beside staged sync recovery. */
const MIGRATION_LOCAL_STAGING_KEY =
  'savePinnedTabs:migration-local-staging';

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

  /** Reads the durable document and whether it is currently synchronized. */
  async readDocument(): Promise<{
    document: SyncDocument | null;
    synchronization: 'synchronized' | 'local-only';
  }> {
    await this.ensureMigrated();
    const stagedRecord = await this.localStorage.get(MIGRATION_STAGING_KEY);
    const staged = stagedRecord[MIGRATION_STAGING_KEY];
    if (staged !== undefined) {
      return {
        document: parseMigratingSyncDocument(staged),
        synchronization: 'local-only',
      };
    }
    return {
      document: await new SyncDocumentStorage(
        this.syncStorage,
        this.localStorage,
      ).read(),
      synchronization: 'synchronized',
    };
  }

  /** Persists local-only changes durably and retries verified sync promotion. */
  async saveDocument(document: SyncDocument): Promise<void> {
    await this.ensureMigrated();
    await this.#runExclusive(async () => {
      const stagedRecord = await this.localStorage.get(MIGRATION_STAGING_KEY);
      const documents = new SyncDocumentStorage(
        this.syncStorage,
        this.localStorage,
      );
      if (stagedRecord[MIGRATION_STAGING_KEY] === undefined) {
        await documents.save(document);
        return;
      }

      await this.localStorage.set({ [MIGRATION_STAGING_KEY]: document });
      try {
        await documents.save(document);
      } catch (error: unknown) {
        if (error instanceof AggregateSyncQuotaError) return;
        throw error;
      }
      await this.localStorage.remove(MIGRATION_STAGING_KEY);
    });
  }


  /** Recovers every valid source, commits a verified generation, then cleans up. */
  async #migrate(): Promise<void> {
    const initialLocal = await this.localStorage.get([
      MIGRATION_STAGING_KEY,
      SYNC_RECOVERY_KEY,
      SYNC_COMMITTED_CACHE_KEY,
    ]);
    const documents = new SyncDocumentStorage(
      this.syncStorage,
      this.localStorage,
      parseMigratingSyncDocument,
    );
    const hasStagedMigration =
      initialLocal[MIGRATION_STAGING_KEY] !== undefined;
    const recoveredOrCached = initialLocal[SYNC_RECOVERY_KEY] !== undefined
      || (!hasStagedMigration
        && initialLocal[SYNC_COMMITTED_CACHE_KEY] !== undefined)
      ? await documents.read()
      : null;
    const [storedSync, storedLocal] = await Promise.all([
      this.syncStorage.get(null),
      this.localStorage.get(null),
    ]);
    let active: SyncDocument | null = recoveredOrCached;
    if (!active) {
      try {
        active = await documents.readSnapshot(storedSync);
      } catch {
        // An invalid or incomplete generation is not allowed to hide old sources.
      }
    }

    let staged: SyncDocument | null = null;
    if (storedLocal[MIGRATION_STAGING_KEY] !== undefined) {
      try {
        staged = parseMigratingSyncDocument(storedLocal[MIGRATION_STAGING_KEY]);
      } catch {
        // Invalid staging data cannot supersede recoverable synchronized data.
      }
    }
    let monolithic: SyncDocument | null = null;
    if (storedSync[SYNC_DOCUMENT_KEY] !== undefined) {
      try {
        monolithic = parseMigratingSyncDocument(storedSync[SYNC_DOCUMENT_KEY]);
      } catch {
        // Invalid monolithic data is independent from other recovery sources.
      }
    }
    let stagedLocal: LocalDocument | null = null;
    if (storedLocal[MIGRATION_LOCAL_STAGING_KEY] !== undefined) {
      try {
        stagedLocal = parseStoredLocalDocument(
          storedLocal[MIGRATION_LOCAL_STAGING_KEY],
          new Set(Object.keys((staged ?? active ?? monolithic)?.sets ?? {})),
        );
      } catch {
        // Invalid local staging cannot replace recoverable legacy references.
      }
    }
    const unversionedSets = unversionedSetEntries(
      storedSync,
      new Set([SYNC_DOCUMENT_KEY, SYNC_INDEX_KEY]),
    );
    const hasRecoverySources = staged !== null
      || monolithic !== null
      || unversionedSets.length > 0;

    if (!active && !hasRecoverySources) {
      const hasInvalidSource = SYNC_INDEX_KEY in storedSync
        || SYNC_DOCUMENT_KEY in storedSync;
      if (hasInvalidSource) {
        throw new Error('No valid synchronized storage source is available');
      }
    }
    const storedLocalDocument = storedLocal[LOCAL_DOCUMENT_KEY];
    const { syncDocument, localDocument } = await migrateStorageState({
      activeSyncDocument: staged ?? active,
      fallbackSyncDocument: staged
        ? active ?? monolithic
        : monolithic,
      unversionedSets,
      localStorage: storedLocal,
      storedLocalDocument,
      stagedLocalDocument: stagedLocal,
      createId: this.#createId === newSetId ? undefined : this.#createId,
    });
    const localChanged = storedLocalDocument === undefined
      || JSON.stringify(localDocument) !== JSON.stringify(storedLocalDocument);

    const obsoleteSyncKeys = unversionedSets.map(([key]) => key).concat(
      monolithic ? [SYNC_DOCUMENT_KEY] : [],
    );
    let synchronized = true;
    if (hasRecoverySources) {
      await this.localStorage.set({
        [MIGRATION_STAGING_KEY]: syncDocument,
        [MIGRATION_LOCAL_STAGING_KEY]: localDocument,
      });
      await documents.removeGenerations();
      await removeKeys(this.syncStorage, obsoleteSyncKeys);
      try {
        await documents.save(syncDocument);
      } catch (error: unknown) {
        if (!(error instanceof AggregateSyncQuotaError)) throw error;
        synchronized = false;
      }
    } else if (!active) {
      await documents.save(syncDocument);
    }

    if (localChanged) {
      await this.localStorage.set({
        [LOCAL_DOCUMENT_KEY]: localDocument,
      });
    }

    await removeKeys(this.localStorage, [
      ...(synchronized ? [MIGRATION_STAGING_KEY] : []),
      MIGRATION_LOCAL_STAGING_KEY,
      ...[LEGACY_SESSIONS_KEY, OBSOLETE_LOCAL_REFERENCES_KEY]
        .filter((key) => key in storedLocal),
    ]);
  }
}
