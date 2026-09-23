/** Isolates compatibility reads for pre-deterministic version-two documents. */

import { isRecord } from '../validation.js';
import {
  parseLocalDocument,
  parseSyncDocument,
  STORAGE_SCHEMA_VERSION,
  type LocalDocument,
  type SyncDocument,
} from './storage-schema.js';

/** Identifies the last document version that assigned random migration IDs. */
const VERSION_TWO = 2;

/** Reads an explicit supported version without retaining migration provenance. */
export function parseStoredSyncDocument(value: unknown): SyncDocument {
  if (isRecord(value) && value['version'] === VERSION_TWO) {
    return parseSyncDocument({
      ...value,
      version: STORAGE_SCHEMA_VERSION,
    });
  }
  return parseSyncDocument(value);
}

/** Marks version-two identity provenance while historical migration runs. */
export function parseMigratingSyncDocument(value: unknown): SyncDocument {
  if (isRecord(value) && value['version'] === VERSION_TWO) {
    const migration = isRecord(value['migration'])
      ? value['migration']
      : { legacyIds: {} };
    return parseSyncDocument({
      ...value,
      version: STORAGE_SCHEMA_VERSION,
      migration,
    });
  }
  return parseSyncDocument(value);
}

/** Reads an explicit supported local version without structural inference. */
export function parseStoredLocalDocument(
  value: unknown,
  knownIds?: ReadonlySet<string>,
): LocalDocument {
  if (isRecord(value) && value['version'] === VERSION_TWO) {
    return parseLocalDocument(
      { ...value, version: STORAGE_SCHEMA_VERSION },
      knownIds,
    );
  }
  return parseLocalDocument(value, knownIds);
}
