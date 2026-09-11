import assert from 'node:assert/strict';
import test from 'node:test';

import { startPopupApp } from '../.extension-build/popup/popup-app.js';

function deferred() {
  return Promise.withResolvers();
}

function createView() {
  const events = [];
  return {
    events,
    bind(actions) { this.actions = actions; },
    confirmDelete: async () => true,
    render(state) { events.push(['render', state]); },
    setPending(pending) { events.push(['pending', pending]); },
    focusSaveName() { events.push(['focus']); },
    showStatus(message, kind) { events.push(['status', kind, message]); },
    clearSaveName() { events.push(['clear']); },
  };
}

const state = { sets: [], activeSetId: null, autoloadSetIds: [] };

test('popup renders a deterministic controller failure without unloading', async () => {
  const view = createView();
  const controller = {
    getPopupState: async () => ({ status: 'success', value: { state } }),
    loadSet: async () => ({ status: 'error', error: new Error('Cannot replace tabs') }),
  };
  await startPopupApp(controller, view);

  await view.actions.load('set-1');

  assert.deepEqual(view.events.slice(-4), [
    ['pending', true],
    ['render', state],
    ['status', 'error', 'Cannot replace tabs'],
    ['pending', false],
  ]);
});

test('popup disables controls and blocks duplicate submissions while pending', async () => {
  const view = createView();
  const pendingSave = deferred();
  let saveCalls = 0;
  const controller = {
    getPopupState: async () => ({ status: 'success', value: { state } }),
    saveSet() {
      saveCalls += 1;
      return pendingSave.promise;
    },
  };
  await startPopupApp(controller, view);

  const first = view.actions.save('Work');
  const duplicate = view.actions.save('Work');
  assert.equal(saveCalls, 1);
  assert.deepEqual(view.events.slice(-2), [
    ['status', 'loading', 'Saving tab set…'],
    ['pending', true],
  ]);

  pendingSave.resolve({ status: 'success', value: { state } });
  await Promise.all([first, duplicate]);
  assert.equal(saveCalls, 1);
  assert.deepEqual(view.events.slice(-4), [
    ['render', state],
    ['clear'],
    ['status', 'success', 'Tab set saved.'],
    ['pending', false],
  ]);
});

test('popup routes append and unload through distinct controller commands', async () => {
  const view = createView();
  const calls = [];
  const controller = {
    getPopupState: async () => ({ status: 'success', value: { state } }),
    appendSet: async (setId) => {
      calls.push(['append', setId]);
      return { status: 'success', value: { state } };
    },
    unloadSet: async (setId) => {
      calls.push(['unload', setId]);
      return { status: 'success', value: { state } };
    },
  };
  await startPopupApp(controller, view);

  await view.actions.append('set-1');
  await view.actions.unload('set-1');

  assert.deepEqual(calls, [
    ['append', 'set-1'],
    ['unload', 'set-1'],
  ]);
  assert.deepEqual(
    view.events.filter((event) => event[0] === 'status' && event[1] === 'success').slice(-2),
    [
      ['status', 'success', 'Tab set appended.'],
      ['status', 'success', 'Tab set unloaded.'],
    ],
  );
});

test('delete cancellation invokes no controller command', async () => {
  const view = createView();
  view.confirmDelete = async () => false;
  let deleteCalls = 0;
  const controller = {
    getPopupState: async () => ({ status: 'success', value: { state } }),
    deleteSet: async () => {
      deleteCalls += 1;
      return { status: 'success', value: { state } };
    },
  };
  await startPopupApp(controller, view);

  await view.actions.delete('set-1');

  assert.equal(deleteCalls, 0);
});

test('delete confirmation locks out competing controller commands', async () => {
  const view = createView();
  const confirmation = deferred();
  view.confirmDelete = () => confirmation.promise;
  let loadCalls = 0;
  let deleteCalls = 0;
  const controller = {
    getPopupState: async () => ({ status: 'success', value: { state } }),
    loadSet: async () => {
      loadCalls += 1;
      return { status: 'success', value: { state } };
    },
    deleteSet: async () => {
      deleteCalls += 1;
      return { status: 'success', value: { state } };
    },
  };
  await startPopupApp(controller, view);

  const deletion = view.actions.delete('set-1');
  await view.actions.load('set-1');
  confirmation.resolve(true);
  await deletion;

  assert.equal(loadCalls, 0);
  assert.equal(deleteCalls, 1);
});
