import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import {
  SyncDocumentStorage,
  SYNC_INDEX_KEY,
} from '../.extension-build/storage/sync-document-storage.js';

const SET_ID = '00000000-0000-4000-8000-000000000135';

function createDocument(opaque) {
  let state = 0x13579bdf;
  const nextToken = () => {
    let token = '';
    for (let index = 0; index < 100; index += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      token += String.fromCharCode(33 + (state % 90));
    }
    return encodeURIComponent(token);
  };
  const tabs = [];
  while (Buffer.byteLength(JSON.stringify(tabs)) < 95_000) {
    const suffix = opaque
      ? nextToken()
      : `shared/application/path/${tabs.length % 20}/${'segment/'.repeat(5)}`;
    tabs.push(`https://example.com/${suffix}`);
  }
  return {
    version: 3,
    sets: {
      [SET_ID]: { id: SET_ID, name: opaque ? 'Opaque' : 'Compressible', tabs },
    },
    autoload: { scope: 'first-window', setIds: [] },
    deletedSetIds: [],
  };
}

function storageArea(initial = {}) {
  const state = structuredClone(initial);
  let retrievalMs = 0;
  return {
    state,
    get retrievalMs() {
      return retrievalMs;
    },
    async get(keys) {
      const start = performance.now();
      const result = keys === null
        ? structuredClone(state)
        : Object.fromEntries((Array.isArray(keys) ? keys : [keys])
          .filter((key) => key in state)
          .map((key) => [key, structuredClone(state[key])]));
      retrievalMs += performance.now() - start;
      return result;
    },
    async set(values) {
      Object.assign(state, structuredClone(values));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
    },
  };
}

async function measureStages(serialized) {
  let start = performance.now();
  const compressed = await new Response(
    new Blob([serialized]).stream().pipeThrough(new CompressionStream('gzip')),
  ).arrayBuffer();
  const compressionMs = performance.now() - start;

  start = performance.now();
  const base64 = Buffer.from(compressed).toString('base64');
  const base64EncodeMs = performance.now() - start;
  start = performance.now();
  const decoded = Buffer.from(base64, 'base64');
  const base64DecodeMs = performance.now() - start;
  start = performance.now();
  const decompressed = await new Response(
    new Blob([decoded]).stream().pipeThrough(new DecompressionStream('gzip')),
  ).text();
  const decompressionMs = performance.now() - start;
  start = performance.now();
  const parsed = JSON.parse(decompressed);
  const parseMs = performance.now() - start;
  start = performance.now();
  const verified = JSON.stringify(parsed) === serialized;
  const verificationMs = performance.now() - start;

  return {
    base64,
    verified,
    compressionMs,
    base64EncodeMs,
    base64DecodeMs,
    decompressionMs,
    parseMs,
    verificationMs,
  };
}

for (const opaque of [false, true]) {
  const fixture = opaque ? 'opaque' : 'compressible';
  test(`near-quota ${fixture} storage pipeline remains responsive`, async () => {
    const document = createDocument(opaque);
    const serialized = JSON.stringify(document);
    const stages = await measureStages(serialized);
    const storage = storageArea();
    const documents = new SyncDocumentStorage(storage);
    const saveStart = performance.now();
    await documents.save(document);
    const saveMs = performance.now() - saveStart;
    const readStart = performance.now();
    assert.deepEqual(await documents.read(), document);
    const readMs = performance.now() - readStart;
    const index = storage.state[SYNC_INDEX_KEY];
    const rawChunkCount = Math.ceil(Buffer.byteLength(JSON.stringify(serialized)) / (6 * 1_024));

    assert.equal(stages.verified, true);
    assert.ok(stages.compressionMs < 1_000);
    assert.ok(stages.decompressionMs < 1_000);
    assert.ok(saveMs < 2_000);
    assert.ok(readMs < 1_000);
    assert.ok(index.chunks.length <= rawChunkCount);
    console.info(JSON.stringify({
      fixture,
      rawBytes: Buffer.byteLength(JSON.stringify(serialized)),
      storedBytes: index.chunks.reduce(
        (total, key) => total + Buffer.byteLength(JSON.stringify(storage.state[key])),
        0,
      ),
      rawChunkCount,
      storedChunkCount: index.chunks.length,
      storageRetrievalMs: storage.retrievalMs,
      saveMs,
      readMs,
      ...stages,
      base64: undefined,
    }));
  });
}
