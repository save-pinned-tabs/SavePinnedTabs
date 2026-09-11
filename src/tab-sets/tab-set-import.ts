/** Normalizes current and legacy tab-set import documents into a common representation. */

import type {
  AutoloadConfiguration,
  AutoloadScope,
  TabSet,
  TabSetId,
} from '../domain.js';

/** Describes a tab set from an unversioned or version 1 import. */
interface LegacyTabSet {
  set_name: string;
  tabs: string[];
  autoload?: 0 | 1;
}

/** Describes a version 2 import with explicit identifiers and autoload configuration. */
interface VersionedTabSetDocument {
  version: 2;
  sets: TabSet[];
  autoload: AutoloadConfiguration;
}

/** Describes a version 1 import containing legacy tab sets keyed by identifier. */
interface VersionedLegacyDocument {
  version: 1;
  sets: Record<string, LegacyTabSet>;
}

/** Represents any supported versioned or unversioned tab-set import document. */
export type TabSetImportDocument =
  | VersionedTabSetDocument
  | VersionedLegacyDocument
  | Record<string, LegacyTabSet>;

/** Represents a tab set converted into the shared import format. */
export interface NormalizedImportSet {
  /** Preserves the imported identifier when the source format provides one. */
  sourceId: TabSetId | null;
  name: string;
  tabs: string[];
  /** Indicates autoload status embedded in a legacy set. */
  isAutoload: boolean;
}

/** Contains normalized sets and autoload metadata ready for import processing. */
export interface NormalizedImport {
  sets: NormalizedImportSet[];
  /** Remains null when the source format has no global autoload scope. */
  scope: AutoloadScope | null;
  /** Identifies autoload sets from formats with explicit set identifiers. */
  autoloadSourceIds: TabSetId[];
}

/** Converts supported import formats without mutating the source document. */
export function normalizeImportDocument(
  document: TabSetImportDocument,
): NormalizedImport {
  if ('version' in document && document.version === 2) {
    return {
      sets: document.sets.map((set) => ({
        sourceId: set.id,
        name: set.name,
        tabs: set.tabs,
        isAutoload: false,
      })),
      scope: document.autoload.scope,
      autoloadSourceIds: document.autoload.setIds,
    };
  }

  const sets = 'version' in document && document.version === 1
    ? document.sets
    : document;
  return {
    sets: Object.values(sets).map((set) => ({
      sourceId: null,
      name: set.set_name,
      tabs: set.tabs,
      isAutoload: set.autoload === 1,
    })),
    scope: null,
    autoloadSourceIds: [],
  };
}
