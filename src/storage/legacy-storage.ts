/** Parses historical storage records and converts them to current documents. */

import type { TabSet } from '../domain.js';
import { isRecord, isStringArray } from '../validation.js';
import {
  emptyLocalDocument,
  emptySyncDocument,
  isUuid,
  type LocalDocument,
  type SyncDocument,
} from './storage-schema.js';

/** Identifies the historical window-session record. */
export const LEGACY_SESSIONS_KEY = 'activeTabs';

/** Identifies obsolete local reference data removed during migration. */
export const OBSOLETE_LOCAL_REFERENCES_KEY = 'shortcutSets';

/** Represents a tab set stored before document storage was introduced. */
export interface LegacySetRecord {
  set_name: string;
  tabs: string[];
  autoload: 0 | 1;
}

/** Represents arbitrary historical entries returned by a browser storage area. */
export type HistoricalStorageRecord = Record<string, unknown>;

/** Represents one validated historical tab-set entry. */
export type LegacySetEntry = [key: string, set: LegacySetRecord];

/** Checks whether a historical key encodes the associated set name. */
function matchesLegacyIdentity(key: string, name: string): boolean {
  try {
    const decoded = atob(key);
    if (btoa(decoded) !== key) return false;
    if (decoded === name) return true;
    const bytes = Uint8Array.from(
      decoded,
      (character) => character.charCodeAt(0),
    );
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes) === name;
  } catch {
    return false;
  }
}

/** Extracts well-formed historical tab sets while excluding document records. */
export function legacySetEntries(
  stored: HistoricalStorageRecord,
  excludedKeys: ReadonlySet<string>,
): LegacySetEntry[] {
  return Object.entries(stored).filter(
    (entry): entry is LegacySetEntry => {
      const [key, value] = entry;
      return !excludedKeys.has(key)
        && isRecord(value)
        && typeof value['set_name'] === 'string'
        && matchesLegacyIdentity(key, value['set_name'])
        && isStringArray(value['tabs'])
        && (value['autoload'] === 0 || value['autoload'] === 1);
    },
  );
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
function recoveredName(
  requested: string,
  sets: Record<string, TabSet>,
): string {
  const names = new Set(Object.values(sets).map(({ name }) => name));
  if (!names.has(requested)) return requested;
  let suffix = 2;
  while (names.has(`${requested} (${suffix})`)) suffix += 1;
  return `${requested} (${suffix})`;
}

/** Recovers the deterministic union of current and historical sources. */
export function recoverSyncDocument(
  active: SyncDocument | null,
  monolithic: SyncDocument | null,
  legacyEntries: readonly LegacySetEntry[],
  createId: () => string,
): SyncDocument {
  const document = active
    ? structuredClone(active)
    : monolithic
      ? structuredClone(monolithic)
      : emptySyncDocument();
  const usedIds = new Set([
    ...Object.keys(document.sets),
    ...document.deletedSetIds,
  ]);
  const legacyIds = {
    ...(monolithic?.migration?.legacyIds ?? {}),
    ...(active?.migration?.legacyIds ?? {}),
  };

  if (active && monolithic) {
    for (const [id, set] of Object.entries(monolithic.sets)) {
      if (!(id in document.sets) && !usedIds.has(id)) {
        document.sets[id] = structuredClone(set);
        usedIds.add(id);
      }
    }
  }

  for (const [legacyId, legacySet] of legacyEntries) {
    const mappedId = legacyIds[legacyId];
    const mappedSet = mappedId ? document.sets[mappedId] : undefined;
    const isExactMigratedCopy = mappedSet
      && mappedSet.name === legacySet.set_name
      && JSON.stringify(mappedSet.tabs) === JSON.stringify(legacySet.tabs);
    if (isExactMigratedCopy) continue;

    const id = mappedId && !usedIds.has(mappedId)
      ? mappedId
      : uniqueId(usedIds, createId);
    usedIds.add(id);
    legacyIds[legacyId] = id;
    document.sets[id] = {
      id,
      name: recoveredName(legacySet.set_name, document.sets),
      tabs: [...legacySet.tabs],
    };
    if (
      legacySet.autoload === 1
      && document.autoload.setIds.length === 0
    ) {
      document.autoload.setIds = [id];
    }
  }

  if (Object.keys(legacyIds).length > 0) {
    document.migration = { legacyIds };
  }
  return document;
}

/** Converts valid historical local references into a current local document. */
export function convertLegacyLocalDocument(
  stored: HistoricalStorageRecord,
  syncDocument: SyncDocument,
): LocalDocument {
  const document = emptyLocalDocument();
  const legacyIds = syncDocument.migration?.legacyIds ?? {};
  const knownIds = new Set(Object.keys(syncDocument.sets));
  const legacySessions = isRecord(stored[LEGACY_SESSIONS_KEY])
    ? stored[LEGACY_SESSIONS_KEY]
    : {};

  for (const [windowId, reference] of Object.entries(legacySessions)) {
    if (typeof reference !== 'string') continue;
    const setId = legacyIds[reference] ?? reference;
    if (knownIds.has(setId)) document.windowSessions[windowId] = setId;
  }
  return document;
}
