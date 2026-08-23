import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function loadSets(savedTabs, initialLocal = {}) {
  const createdTabs = [];
  const local = { ...initialLocal };
  const alerts = [];

  globalThis.swal = (options) => {
    alerts.push(options);
    return Promise.resolve();
  };

  globalThis.chrome = {
    windows: {
      getCurrent: async () => ({ id: 1 }),
    },
    storage: {
      sync: {
        get: async (id) => ({
          [id]: { tabs: savedTabs },
        }),
      },
      local: {
        get: async (keys) => {
          const names = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(
            names.filter((name) => name in local).map((name) => [name, local[name]]),
          );
        },
        set: async (values) => {
          Object.assign(local, values);
        },
        remove: async (key) => {
          delete local[key];
        },
      },
    },
    tabs: {
      query: async () => [],
      remove: async () => {},
      create: async (properties) => {
        if (properties.url.startsWith('file:')) {
          throw new Error('Illegal URL');
        }
        createdTabs.push(properties);
      },
    },
  };
  globalThis.window = { location: { href: '' } };

  const source = await readFile(new URL('../functions.js', import.meta.url), 'utf8');
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${crypto.randomUUID()}`;
  const { Sets } = await import(moduleUrl);

  if (savedTabs !== undefined) {
    await Sets.load('saved', 1);
  }
  return { Sets, alerts, createdTabs, local };
}

test('restores supported tabs and records rejected tabs', async () => {
  const fileUrl = 'file:///home/user/Downloads/example%20book.pdf';
  const result = await loadSets(['https://example.com/', fileUrl]);

  assert.deepEqual(result.createdTabs.map(({ url }) => url), ['https://example.com/']);
  assert.deepEqual(result.local.restoreErrors, [
    { url: fileUrl, message: 'Illegal URL' },
  ]);
});

test('clears stale restoration errors after a successful load', async () => {
  const result = await loadSets(
    ['https://example.com/'],
    { restoreErrors: [{ url: 'file:///old.pdf', message: 'Illegal URL' }] },
  );

  assert.deepEqual(result.createdTabs.map(({ url }) => url), ['https://example.com/']);
  assert.equal('restoreErrors' in result.local, false);
});

test('reports restoration errors once', async () => {
  const { Sets, alerts, local } = await loadSets(undefined, {
    restoreErrors: [
      { url: 'file:///first.pdf', message: 'Illegal URL' },
      { url: 'file:///second.pdf', message: 'Access denied' },
    ],
  });

  await Sets.reportRestoreErrors();
  await Sets.reportRestoreErrors();

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].title, 'Some tabs could not be restored');
  assert.equal(alerts[0].icon, 'error');
  assert.match(alerts[0].text, /file:\/\/\/first\.pdf\nIllegal URL/);
  assert.match(alerts[0].text, /file:\/\/\/second\.pdf\nAccess denied/);
  assert.equal('restoreErrors' in local, false);
});
