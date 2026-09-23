/** Persists synchronized documents as verified, generation-scoped chunks. */

import type { BrowserStorageArea } from '../browser-api.js';
import { parseSyncDocument, type SyncDocument } from './storage-schema.js';

export const SYNC_INDEX_KEY = 'savePinnedTabs:index';
export const SYNC_CHUNK_PREFIX = 'savePinnedTabs:generation:';
export const SYNC_CHUNK_PAYLOAD_BYTES = 6 * 1024;
const CHUNK_SCHEMA_VERSION = 3;

/** Points readers at one complete ordered chunk generation. */
interface SyncIndex {
  version: typeof CHUNK_SCHEMA_VERSION;
  generation: string;
  chunks: string[];
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
  /** Creates a document store over one browser synchronization area. */
  constructor(private readonly storage: BrowserStorageArea) {}

  /** Reads the active generation, with a version-two fallback for migration. */
  async read(): Promise<SyncDocument | null> {
    const indexRecord = await this.storage.get(SYNC_INDEX_KEY);
    const index = indexRecord[SYNC_INDEX_KEY];
    if (index === undefined) {
      const legacy = await this.storage.get('savePinnedTabs:sync');
      const document = legacy['savePinnedTabs:sync'];
      return document === undefined ? null : parseSyncDocument(document);
    }
    if (!isSyncIndex(index)) throw new TypeError('Stored synchronized index is invalid');
    return this.parseIndex(index, await this.storage.get(index.chunks));
  }

  /** Reads an active generation from a previously fetched complete storage snapshot. */
  readSnapshot(stored: Record<string, unknown>): SyncDocument | null {
    const index = stored[SYNC_INDEX_KEY];
    if (index === undefined) {
      const document = stored['savePinnedTabs:sync'];
      return document === undefined ? null : parseSyncDocument(document);
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

  /** Writes and verifies a generation before atomically switching the index. */
  async save(document: SyncDocument): Promise<void> {
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

    let switched = false;
    try {
      await this.storage.set(
        Object.fromEntries(keys.map((key, index) => [key, chunks[index]])),
      );
      const nextIndex: SyncIndex = {
        version: CHUNK_SCHEMA_VERSION,
        generation,
        chunks: keys,
      };
      const verified = this.parseIndex(
        nextIndex,
        await this.storage.get(nextIndex.chunks),
      );
      if (JSON.stringify(verified) !== JSON.stringify(normalizedDocument)) {
        throw new Error('Verified synchronized generation differs from the requested document');
      }
      await this.storage.set({ [SYNC_INDEX_KEY]: nextIndex });
      switched = true;
      await this.read();
    } catch (error: unknown) {
      if (switched) {
        if (previous) {
          await this.storage.set({ [SYNC_INDEX_KEY]: previous });
        } else {
          await this.storage.remove(SYNC_INDEX_KEY);
        }
      }
      await removeQuietly(this.storage, keys);
      throw quotaError(error);
    }

    if (previous) await removeQuietly(this.storage, previous.chunks);
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
      return parseSyncDocument(JSON.parse(serialized));
    } catch (cause: unknown) {
      throw new TypeError('Stored synchronized generation is invalid', { cause });
    }
  }
}
