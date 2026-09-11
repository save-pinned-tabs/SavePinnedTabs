import type {
  AutoloadConfiguration,
  AutoloadScope,
  TabSet,
  TabSetId,
} from '../domain.js';

interface LegacyTabSet {
  set_name: string;
  tabs: string[];
  autoload?: 0 | 1;
}

interface VersionedTabSetDocument {
  version: 2;
  sets: TabSet[];
  autoload: AutoloadConfiguration;
}

interface VersionedLegacyDocument {
  version: 1;
  sets: Record<string, LegacyTabSet>;
}

export type TabSetImportDocument =
  | VersionedTabSetDocument
  | VersionedLegacyDocument
  | Record<string, LegacyTabSet>;

export interface NormalizedImportSet {
  sourceId: TabSetId | null;
  name: string;
  tabs: string[];
  isAutoload: boolean;
}

export interface NormalizedImport {
  sets: NormalizedImportSet[];
  scope: AutoloadScope | null;
  autoloadSourceIds: TabSetId[];
}

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
