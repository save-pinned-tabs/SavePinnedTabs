/** Persists synchronized documents as verified, generation-scoped chunks. */

import type { BrowserStorageArea } from '../browser-api.js';
import {
  createSerializedStorageOperation,
  type SerializedOperation,
} from './serialized-operation.js';
import { parseSyncDocument, type SyncDocument } from './storage-schema.js';
import { parseStoredSyncDocument } from './migration/v2-documents.js';

export const SYNC_INDEX_KEY = 'savePinnedTabs:index';
export const SYNC_CHUNK_PREFIX = 'savePinnedTabs:generation:';
export const SYNC_CHUNK_PAYLOAD_BYTES = 6 * 1024;
export const SYNC_RECOVERY_KEY = 'savePinnedTabs:sync-recovery';
export const SYNC_COMMITTED_CACHE_KEY = 'savePinnedTabs:sync-committed-cache';
const CHUNK_SCHEMA_VERSION = 3;
const DOCUMENT_LOCK = 'save-pinned-tabs:sync-document';

/** Points readers at one complete ordered chunk generation. */
interface SyncIndex {
  version: typeof CHUNK_SCHEMA_VERSION;
  generation: string;
  chunks: string[];
}

/** Preserves the previous generation while its synchronized chunks are reclaimed. */
interface SyncRecovery {
  version: 1;
  previousIndex: SyncIndex;
  previousChunks: Record<string, string>;
  nextIndex: SyncIndex;
}

/** Caches the last complete synchronized document observed on this device. */
interface SyncCommittedCache {
  version: 1;
  generation: string;
  document: SyncDocument;
}

/** Checks the persisted shape and generation ownership of a chunk index. */
function isSyncIndex(value: unknown): value is SyncIndex {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const index = value as Record<string, unknown>;
  return index.version === CHUNK_SCHEMA_VERSION
    && typeof index.generation === 'string'
    && Array.isArray(index.chunks)
    && index.chunks.length > 0
    && index.chunks.every((key) => typeof key === 'string'
      && key.startsWith(`${SYNC_CHUNK_PREFIX}${index.generation}:chunk:`));
}

/** Checks a locally staged rollback record before using it for recovery. */
function isSyncRecovery(value: unknown): value is SyncRecovery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const recovery = value as Record<string, unknown>;
  if (recovery.version !== 1
    || !isSyncIndex(recovery.previousIndex)
    || !isSyncIndex(recovery.nextIndex)
    || !recovery.previousChunks
    || typeof recovery.previousChunks !== 'object'
    || Array.isArray(recovery.previousChunks)) {
    return false;
  }
  const chunks = recovery.previousChunks as Record<string, unknown>;
  return recovery.previousIndex.chunks.every(
    (key) => typeof chunks[key] === 'string',
  );
}

/** Parses a local committed-document cache used during non-atomic Sync propagation. */
function parseCommittedCache(value: unknown): SyncCommittedCache | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const cache = value as Record<string, unknown>;
  if (cache.version !== 1 || typeof cache.generation !== 'string') return null;
  try {
    return {
      version: 1,
      generation: cache.generation,
      document: parseSyncDocument(cache.document),
    };
  } catch {
    return null;
  }
}

/** Measures one character after JSON string escaping. */
function jsonStringCharacterBytes(character: string): number {
  if (character === '\"' || character === '\\\\') return 2;
  const codePoint = character.codePointAt(0) ?? 0;
  if (codePoint <= 0x1f) {
    return '\\b\\f\\n\\r\\t'.includes(character) ? 2 : 6;
  }
  return new TextEncoder().encode(character).byteLength;
}

/** Splits text without breaking code points or exceeding the JSON byte limit. */
function splitUtf8(value: string): string[] {
  const chunks: string[] = [];
  let chunk = '';
  let bytes = 2;

  for (const character of value) {
    const characterBytes = jsonStringCharacterBytes(character);
    if (bytes + characterBytes > SYNC_CHUNK_PAYLOAD_BYTES && chunk) {
      chunks.push(chunk);
      chunk = '';
      bytes = 2;
    }
    chunk += character;
    bytes += characterBytes;
  }
  chunks.push(chunk);
  return chunks;
}

/** Creates a generation identifier unique across devices and writes. */
function generationId(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID()}`;
}

/** Identifies aggregate quota exhaustion for this extension's sync storage. */
export class AggregateSyncQuotaError extends Error {}

/** Translates browser quota failures into actionable synchronized-storage errors. */
function quotaError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  let guidance = 'Synchronized storage could not be updated';
  if (normalized.includes('quota_bytes_per_item') || normalized.includes('per-item')) {
    guidance = 'A synchronized storage item exceeded the browser per-item quota';
  } else if (normalized.includes('max_items') || normalized.includes('item-count')) {
    guidance = 'Synchronized storage has reached the browser item-count quota';
  } else if (
    normalized.includes('quota_bytes')
    || normalized.includes('kquotabytes')
    || normalized.includes('quotaexceedederror')
    || normalized.includes('exceeded its quota')
    || normalized.includes('total')
  ) {
    return new AggregateSyncQuotaError(
      `Synchronized storage for this extension is full; reduce saved tab data: ${message}`,
      { cause: error },
    );
  } else if (normalized.includes('write') && (normalized.includes('rate') || normalized.includes('thrott'))) {
    guidance = 'The browser is throttling synchronized storage writes; wait before retrying';
  }
  return new Error(`${guidance}: ${message}`, { cause: error });
}

/** Best-effort cleanup that cannot invalidate the active generation. */
async function removeQuietly(storage: BrowserStorageArea, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await storage.remove(keys);
  } catch {
    // Cleanup is retryable; the active index never references these chunks.
  }
}

/** Reads and transactionally replaces synchronized chunk generations. */
export class SyncDocumentStorage {
  #runExclusive: SerializedOperation;

  /** Creates a document store over synchronized storage and optional local recovery storage. */
  constructor(
    private readonly storage: BrowserStorageArea,
    private readonly recoveryStorage?: BrowserStorageArea,
    private readonly parseStoredDocument = parseStoredSyncDocument,
  ) {
    this.#runExclusive = createSerializedStorageOperation(
      storage,
      DOCUMENT_LOCK,
    );
  }

  /** Reads a complete active generation under cross-context serialization. */
  read(): Promise<SyncDocument | null> {
    return this.#runExclusive(() => this.readDocument());
  }

  /** Reads a complete active generation or the last locally observed committed generation. */
  private async readDocument(): Promise<SyncDocument | null> {
    const recovered = await this.recover();
    if (recovered) return recovered;
    const indexRecord = await this.storage.get(SYNC_INDEX_KEY);
    const index = indexRecord[SYNC_INDEX_KEY];
    if (index === undefined) {
      const legacy = await this.storage.get('savePinnedTabs:sync');
      const document = legacy['savePinnedTabs:sync'];
      return document === undefined ? null : this.parseStoredDocument(document);
    }
    if (!isSyncIndex(index)) throw new TypeError('Stored synchronized index is invalid');
    try {
      const document = this.parseIndex(index, await this.storage.get(index.chunks));
      await this.cacheCommitted(index.generation, document);
      return document;
    } catch (error) {
      const cached = await this.readCommittedCache();
      if (cached) return cached.document;
      throw error;
    }
  }

  /** Reads an active generation from a previously fetched complete storage snapshot. */
  readSnapshot(stored: Record<string, unknown>): SyncDocument | null {
    const index = stored[SYNC_INDEX_KEY];
    if (index === undefined) {
      const document = stored['savePinnedTabs:sync'];
      return document === undefined ? null : this.parseStoredDocument(document);
    }
    if (!isSyncIndex(index)) {
      throw new TypeError('Stored synchronized index is invalid');
    }
    return this.parseIndex(index, stored);
  }

  /** Removes every indexed or orphaned chunk generation after recovery is staged. */
  async removeGenerations(): Promise<void> {
    const stored = await this.storage.get(null);
    const keys = Object.keys(stored).filter(
      (key) => key === SYNC_INDEX_KEY || key.startsWith(SYNC_CHUNK_PREFIX),
    );
    if (keys.length > 0) await this.storage.remove(keys);
  }

  /** Reclaims the previous generation under cross-context serialization. */
  save(document: SyncDocument): Promise<void> {
    return this.#runExclusive(() => this.saveDocument(document));
  }

  /** Reclaims the previous generation through a locally staged rollback copy. */
  private async saveDocument(document: SyncDocument): Promise<void> {
    await this.recover();
    const previousRecord = await this.storage.get(SYNC_INDEX_KEY);
    const previous = isSyncIndex(previousRecord[SYNC_INDEX_KEY])
      ? previousRecord[SYNC_INDEX_KEY]
      : null;
    const generation = generationId();
    const normalizedDocument = parseSyncDocument(document);
    const chunks = splitUtf8(JSON.stringify(normalizedDocument));
    const keys = chunks.map((_, index) =>
      `${SYNC_CHUNK_PREFIX}${generation}:chunk:${index}`
    );
    const nextIndex: SyncIndex = {
      version: CHUNK_SCHEMA_VERSION,
      generation,
      chunks: keys,
    };
    let recovery: SyncRecovery | null = null;
    let committed = false;

    try {
      if (previous && this.recoveryStorage) {
        const previousChunks = await this.storage.get(previous.chunks);
        this.parseIndex(previous, previousChunks);
        recovery = {
          version: 1,
          previousIndex: previous,
          previousChunks: previousChunks as Record<string, string>,
          nextIndex,
        };
        await this.recoveryStorage.set({ [SYNC_RECOVERY_KEY]: recovery });
        await this.storage.remove(previous.chunks);
      }

      await this.storage.set(
        Object.fromEntries(keys.map((key, index) => [key, chunks[index]])),
      );
      const verified = this.parseIndex(
        nextIndex,
        await this.storage.get(nextIndex.chunks),
      );
      if (JSON.stringify(verified) !== JSON.stringify(normalizedDocument)) {
        throw new Error('Verified synchronized generation differs from the requested document');
      }
      await this.storage.set({ [SYNC_INDEX_KEY]: nextIndex });
      committed = true;
      this.parseIndex(nextIndex, await this.storage.get(nextIndex.chunks));
    } catch (error: unknown) {
      if (!committed) {
        if (recovery) {
          await this.restore(recovery);
        } else {
          await removeQuietly(this.storage, keys);
        }
        throw quotaError(error);
      }
    }

    if (previous) await removeQuietly(this.storage, previous.chunks);
    await this.cacheCommitted(nextIndex.generation, normalizedDocument);
    if (this.recoveryStorage) {
      await removeQuietly(this.recoveryStorage, [SYNC_RECOVERY_KEY]);
    }
  }

  /** Resolves an interrupted replacement to one complete committed generation. */
  private async recover(): Promise<SyncDocument | null> {
    if (!this.recoveryStorage) return null;
    const record = await this.recoveryStorage.get(SYNC_RECOVERY_KEY);
    const recovery = record[SYNC_RECOVERY_KEY];
    if (recovery === undefined) return null;
    if (!isSyncRecovery(recovery)) {
      throw new TypeError('Stored synchronized recovery record is invalid');
    }

    const indexRecord = await this.storage.get(SYNC_INDEX_KEY);
    const activeIndex = indexRecord[SYNC_INDEX_KEY];
    if (isSyncIndex(activeIndex)
      && activeIndex.generation === recovery.nextIndex.generation) {
      try {
        const document = this.parseIndex(
          activeIndex,
          await this.storage.get(activeIndex.chunks),
        );
        await removeQuietly(this.storage, recovery.previousIndex.chunks);
        await removeQuietly(this.recoveryStorage, [SYNC_RECOVERY_KEY]);
        return document;
      } catch {
        return this.restore(recovery);
      }
    }
    if (isSyncIndex(activeIndex)
      && activeIndex.generation !== recovery.previousIndex.generation) {
      let document: SyncDocument;
      try {
        document = this.parseIndex(
          activeIndex,
          await this.storage.get(activeIndex.chunks),
        );
      } catch {
        return this.parseIndex(
          recovery.previousIndex,
          recovery.previousChunks,
        );
      }
      try {
        await this.cacheCommitted(activeIndex.generation, document);
      } catch {
        // The complete synchronized generation remains authoritative and readable.
      }
      await removeQuietly(this.storage, [
        ...recovery.previousIndex.chunks,
        ...recovery.nextIndex.chunks,
      ]);
      await removeQuietly(this.recoveryStorage, [SYNC_RECOVERY_KEY]);
      return document;
    }


    return this.restore(recovery);
  }

  /** Restores the previous index after discarding an incomplete replacement. */
  private async restore(recovery: SyncRecovery): Promise<SyncDocument> {
    await removeQuietly(this.storage, recovery.nextIndex.chunks);
    await this.storage.set(recovery.previousChunks);
    await this.storage.set({ [SYNC_INDEX_KEY]: recovery.previousIndex });
    const document = this.parseIndex(
      recovery.previousIndex,
      await this.storage.get(recovery.previousIndex.chunks),
    );
    await this.cacheCommitted(recovery.previousIndex.generation, document);
    if (this.recoveryStorage) {
      await removeQuietly(this.recoveryStorage, [SYNC_RECOVERY_KEY]);
    }
    return document;
  }

  /** Stores the latest complete document for reads during cross-device propagation gaps. */
  private async cacheCommitted(
    generation: string,
    document: SyncDocument,
  ): Promise<void> {
    if (!this.recoveryStorage) return;
    const cache: SyncCommittedCache = { version: 1, generation, document };
    await this.recoveryStorage.set({ [SYNC_COMMITTED_CACHE_KEY]: cache });
  }

  /** Reads and validates this device's last complete synchronized document. */
  private async readCommittedCache(): Promise<SyncCommittedCache | null> {
    if (!this.recoveryStorage) return null;
    const stored = await this.recoveryStorage.get(SYNC_COMMITTED_CACHE_KEY);
    return parseCommittedCache(stored[SYNC_COMMITTED_CACHE_KEY]);
  }


  /** Reconstructs and validates an indexed generation from retrieved chunks. */
  private parseIndex(
    index: SyncIndex,
    stored: Record<string, unknown>,
  ): SyncDocument {
    let serialized = '';
    for (const key of index.chunks) {
      const chunk = stored[key];
      if (typeof chunk !== 'string') {
        throw new TypeError(`Synchronized generation is missing chunk "${key}"`);
      }
      serialized += chunk;
    }
    try {
      return this.parseStoredDocument(JSON.parse(serialized));
    } catch (cause: unknown) {
      throw new TypeError('Stored synchronized generation is invalid', { cause });
    }
  }
}
