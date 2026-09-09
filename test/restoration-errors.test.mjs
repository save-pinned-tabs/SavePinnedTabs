import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createLockManager() {
  const tails = new Map();
  const requestWaiters = [];
  let requestCount = 0;

  function notifyRequestWaiters() {
    for (let i = requestWaiters.length - 1; i >= 0; i -= 1) {
      if (requestCount >= requestWaiters[i].count) {
        requestWaiters.splice(i, 1)[0].resolve();
      }
    }
  }

  return {
    async request(name, callback) {
      requestCount += 1;
      notifyRequestWaiters();

      const previous = tails.get(name) || Promise.resolve();
      let release;
      const current = new Promise((resolve) => {
        release = resolve;
      });
      tails.set(name, current);

      await previous;
      try {
        return await callback();
      } finally {
        release();
        if (tails.get(name) === current) {
          tails.delete(name);
        }
      }
    },
    waitForRequestCount(count) {
      if (requestCount >= count) return Promise.resolve();
      return new Promise((resolve) => {
        requestWaiters.push({ count, resolve });
      });
    },
  };
}

async function loadSets(savedTabs, initialLocal = {}, options = {}) {
  const createdTabs = [];
  const local = { ...initialLocal };
  const alerts = [];
  const lockManager = createLockManager();

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
          const result = Object.fromEntries(
            names.filter((name) => name in local).map((name) => [name, local[name]]),
          );
          if (options.beforeLocalGetReturn) {
            await options.beforeLocalGetReturn(names);
          }
          return result;
        },
        set: async (values) => {
          Object.assign(local, values);
          if (options.afterLocalSet) {
            await options.afterLocalSet(values);
          }
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
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { locks: lockManager },
  });

  const source = await readFile(new URL('../functions.js', import.meta.url), 'utf8');
  const importSets = async () => {
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${crypto.randomUUID()}`;
    return (await import(moduleUrl)).Sets;
  };
  const Sets = await importSets();

  const shouldAutoLoad = options.autoLoad === undefined
    ? savedTabs !== undefined
    : options.autoLoad;
  if (shouldAutoLoad) {
    await Sets.load('saved', 1);
  }
  return {
    Sets,
    alerts,
    createdTabs,
    importSets,
    local,
    lockManager,
  };
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

  await Promise.all([
    Sets.reportRestoreErrors(),
    Sets.reportRestoreErrors(),
  ]);

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].title, 'Some tabs could not be restored');
  assert.equal(alerts[0].icon, 'error');
  assert.match(alerts[0].text, /file:\/\/\/first\.pdf\nIllegal URL/);
  assert.match(alerts[0].text, /file:\/\/\/second\.pdf\nAccess denied/);
  assert.equal('restoreErrors' in local, false);
});

test('preserves a newer report written while an older report is consumed', async () => {
  const reportRead = createDeferred();
  const continueReportRead = createDeferred();
  const newerReportWritten = createDeferred();
  let pauseReportRead = true;
  const oldError = { url: 'file:///old.pdf', message: 'Old failure' };
  const newUrl = 'file:///new.pdf';
  const harness = await loadSets([newUrl], { restoreErrors: [oldError] }, {
    autoLoad: false,
    beforeLocalGetReturn: async (names) => {
      if (pauseReportRead && names.includes('restoreErrors')) {
        pauseReportRead = false;
        reportRead.resolve();
        await continueReportRead.promise;
      }
    },
    afterLocalSet: async (values) => {
      if ('restoreErrors' in values) {
        newerReportWritten.resolve();
      }
    },
  });
  const workerSets = await harness.importSets();

  const reportPromise = harness.Sets.reportRestoreErrors();
  await reportRead.promise;

  const loadPromise = workerSets.load('saved', 1);
  await Promise.race([
    harness.lockManager.waitForRequestCount(2),
    newerReportWritten.promise,
  ]);
  continueReportRead.resolve();
  await Promise.all([reportPromise, loadPromise]);

  assert.equal(harness.alerts.length, 1);
  assert.match(harness.alerts[0].text, /file:\/\/\/old\.pdf\nOld failure/);
  assert.deepEqual(harness.local.restoreErrors, [
    { url: newUrl, message: 'Illegal URL' },
  ]);
});
