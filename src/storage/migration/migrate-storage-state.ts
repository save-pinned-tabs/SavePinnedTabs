/** Converts historical storage sources into current synchronized and local documents. */

import type { TabSet } from '../../domain.js';
import { isRecord } from '../../validation.js';
import {
  emptyLocalDocument,
  emptySyncDocument,
  isUuid,
  type LocalDocument,
  type SyncDocument,
} from '../storage-schema.js';
import { parseStoredLocalDocument } from './v2-documents.js';
import {
  LEGACY_SESSIONS_KEY,
  type HistoricalStorageRecord,
  type UnversionedSetEntry,
} from './unversioned-records.js';

/** Describes every validated source used to construct current storage. */
export interface MigrationSources {
  activeSyncDocument: SyncDocument | null;
  fallbackSyncDocument: SyncDocument | null;
  unversionedSets: readonly UnversionedSetEntry[];
  localStorage: HistoricalStorageRecord;
  storedLocalDocument?: unknown;
  stagedLocalDocument: LocalDocument | null;
  createId: (() => string) | undefined;
}

/** Contains the current documents produced by historical migration. */
export interface MigratedStorageState {
  syncDocument: SyncDocument;
  localDocument: LocalDocument;
}

/** Derives a cross-browser UUID from the stable unversioned storage key. */
async function unversionedSetId(unversionedId: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(unversionedId)),
  );
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(digest.slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

/** Generates an unused valid UUID and reserves it in the supplied set. */
function uniqueId(usedIds: Set<string>, createId: () => string): string {
  let id: string;
  do {
    id = createId();
  } while (!isUuid(id) || usedIds.has(id));
  usedIds.add(id);
  return id;
}

/** Chooses a deterministic display name without treating names as identity. */
function migratedName(
  requested: string,
  sets: Readonly<Record<string, TabSet>>,
): string {
  const names = new Set(Object.values(sets).map(({ name }) => name));
  if (!names.has(requested)) return requested;
  let suffix = 2;
  while (names.has(`${requested} (${suffix})`)) suffix += 1;
  return `${requested} (${suffix})`;
}

/** Merges synchronized sources and records transient reference resolutions. */
async function migrateSyncDocument(
  sources: MigrationSources,
): Promise<{ document: SyncDocument; references: Record<string, string> }> {
  const { activeSyncDocument: active, fallbackSyncDocument: fallback } = sources;
  const document = active
    ? structuredClone(active)
    : fallback
      ? structuredClone(fallback)
      : emptySyncDocument();
  const usedIds = new Set([
    ...Object.keys(document.sets),
    ...document.deletedSetIds,
  ]);
  const legacyIds = {
    ...(fallback?.migration?.legacyIds ?? {}),
    ...(active?.migration?.legacyIds ?? {}),
  };
  const requiresVersionTwoCompatibility = active?.migration !== undefined
    || fallback?.migration !== undefined;
  const references: Record<string, string> = {};

  if (active && fallback) {
    for (const [id, set] of Object.entries(fallback.sets)) {
      if (!(id in document.sets) && !usedIds.has(id)) {
        document.sets[id] = structuredClone(set);
        usedIds.add(id);
      }
    }
  }

  for (const [unversionedId, unversionedSet] of sources.unversionedSets) {
    const deterministicId = await unversionedSetId(unversionedId);
    const mappedId = legacyIds[unversionedId];
    const mappedSet = mappedId ? document.sets[mappedId] : undefined;
    const mappedSetIsExact = mappedSet
      && mappedSet.name === unversionedSet.set_name
      && JSON.stringify(mappedSet.tabs) === JSON.stringify(unversionedSet.tabs);
    if (mappedSetIsExact) {
      references[unversionedId] = mappedSet.id;
      continue;
    }
    const exactSet = Object.values(document.sets).find(
      (set) => set.name === unversionedSet.set_name
        && JSON.stringify(set.tabs) === JSON.stringify(unversionedSet.tabs),
    );
    if (!mappedId && exactSet) {
      references[unversionedId] = exactSet.id;
      if (requiresVersionTwoCompatibility) {
        legacyIds[unversionedId] = exactSet.id;
      }
      continue;
    }

    let id: string;
    let requiresCompatibilityMapping = false;
    if (mappedId && !usedIds.has(mappedId)) {
      id = mappedId;
      requiresCompatibilityMapping = true;
    } else if (!sources.createId && !usedIds.has(deterministicId)) {
      id = deterministicId;
      usedIds.add(id);
    } else {
      id = uniqueId(usedIds, sources.createId ?? (() => crypto.randomUUID()));
      requiresCompatibilityMapping = true;
    }
    if (requiresCompatibilityMapping) legacyIds[unversionedId] = id;
    usedIds.add(id);
    document.sets[id] = {
      id,
      name: migratedName(unversionedSet.set_name, document.sets),
      tabs: [...unversionedSet.tabs],
    };
    references[unversionedId] = id;
    if (
      unversionedSet.autoload === 1
      && document.autoload.setIds.length === 0
    ) {
      document.autoload.setIds = [id];
    }
  }

  if (Object.keys(legacyIds).length > 0) {
    document.migration = { legacyIds };
  } else {
    delete document.migration;
  }
  return { document, references };
}

/** Converts valid unversioned local references into a current local document. */
async function migrateUnversionedLocalDocument(
  stored: HistoricalStorageRecord,
  syncDocument: SyncDocument,
  references: Readonly<Record<string, string>>,
): Promise<LocalDocument> {
  const document = emptyLocalDocument();
  const legacyIds = syncDocument.migration?.legacyIds ?? {};
  const knownIds = new Set(Object.keys(syncDocument.sets));
  const legacySessions = isRecord(stored[LEGACY_SESSIONS_KEY])
    ? stored[LEGACY_SESSIONS_KEY]
    : {};

  for (const [windowId, reference] of Object.entries(legacySessions)) {
    if (typeof reference !== 'string') continue;
    const setId = references[reference]
      ?? legacyIds[reference]
      ?? await unversionedSetId(reference);
    if (knownIds.has(setId)) document.windowSessions[windowId] = setId;
  }
  return document;
}

/** Produces synchronized and local current documents as one migration unit. */
export async function migrateStorageState(
  sources: MigrationSources,
): Promise<MigratedStorageState> {
  const { document: syncDocument, references } =
    await migrateSyncDocument(sources);
  const knownIds = new Set(Object.keys(syncDocument.sets));
  const localDocument = sources.stagedLocalDocument
    ?? (sources.storedLocalDocument === undefined
      ? await migrateUnversionedLocalDocument(
          sources.localStorage,
          syncDocument,
          references,
        )
      : parseStoredLocalDocument(sources.storedLocalDocument, knownIds));
  return { syncDocument, localDocument };
}
