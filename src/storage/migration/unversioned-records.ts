/** Parses tab-set records stored before versioned documents were introduced. */

import { isRecord, isStringArray } from '../../validation.js';

/** Identifies the historical window-session record. */
export const LEGACY_SESSIONS_KEY = 'activeTabs';

/** Identifies obsolete local reference data removed during migration. */
export const OBSOLETE_LOCAL_REFERENCES_KEY = 'shortcutSets';

/** Represents a tab set stored before document storage was introduced. */
export interface UnversionedSetRecord {
  set_name: string;
  tabs: string[];
  autoload: 0 | 1;
}

/** Represents arbitrary historical entries returned by a browser storage area. */
export type HistoricalStorageRecord = Record<string, unknown>;

/** Represents one validated unversioned tab-set entry. */
export type UnversionedSetEntry = [key: string, set: UnversionedSetRecord];

/** Checks whether a historical key encodes the associated set name. */
function matchesUnversionedIdentity(key: string, name: string): boolean {
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

/** Extracts well-formed unversioned tab sets while excluding document records. */
export function unversionedSetEntries(
  stored: HistoricalStorageRecord,
  excludedKeys: ReadonlySet<string>,
): UnversionedSetEntry[] {
  return Object.entries(stored).filter(
    (entry): entry is UnversionedSetEntry => {
      const [key, value] = entry;
      return !excludedKeys.has(key)
        && isRecord(value)
        && typeof value['set_name'] === 'string'
        && matchesUnversionedIdentity(key, value['set_name'])
        && isStringArray(value['tabs'])
        && (value['autoload'] === 0 || value['autoload'] === 1);
    },
  );
}
