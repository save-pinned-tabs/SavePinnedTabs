import assert from 'node:assert/strict';
import test from 'node:test';

import { startOptionsApp } from '../.extension-build/options/options-app.js';

function createView() {
  const events = [];
  return {
    events,
    bind(actions) { this.actions = actions; },
    render(state) { events.push(['render', state]); },
    setPending(pending) { events.push(['pending', pending]); },
    showStatus(message, kind) { events.push(['status', kind, message]); },
    readImportDocument: async (file) => file.document,
    downloadExport(document) { events.push(['download', document]); },
    clearImport() { events.push(['clear-import']); },
  };
}

const optionsState = { sets: [] };


test('options import invokes one controller command and reports its result', async () => {
  const view = createView();
  let importCalls = 0;
  const controller = {
    getOptionsState: async () => ({ status: 'success', value: { state: optionsState } }),
    importSets: async (document) => {
      importCalls += 1;
      assert.deepEqual(document, { version: 2 });
      return {
        status: 'success',
        value: { importedCount: 2, state: optionsState },
      };
    },
  };
  await startOptionsApp(controller, view);

  await view.actions.import({ document: { version: 2 } });

  assert.equal(importCalls, 1);
  assert.deepEqual(view.events.slice(-5), [
    ['pending', true],
    ['render', optionsState],
    ['clear-import'],
    ['status', 'success', 'Successfully imported 2 tab sets.'],
    ['pending', false],
  ]);
});

test('options reports malformed files without calling the controller', async () => {
  const view = createView();
  view.readImportDocument = async () => { throw new SyntaxError('Unexpected token'); };
  let importCalls = 0;
  const controller = {
    getOptionsState: async () => ({ status: 'success', value: { state: optionsState } }),
    importSets: async () => { importCalls += 1; },
  };
  await startOptionsApp(controller, view);

  await view.actions.import({});

  assert.equal(importCalls, 0);
  assert.deepEqual(view.events.slice(-3), [
    ['clear-import'],
    ['status', 'error', 'Unexpected token'],
    ['pending', false],
  ]);
});
