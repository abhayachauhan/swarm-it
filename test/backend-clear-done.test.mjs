// clear-done: one click removes every finished worker from the rail, and never touches a running one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, applyStateChange } from '../backend/store.mjs';
import { createAttention } from '../backend/attention.mjs';
import { clearDone } from '../backend/actions.mjs';
import { makeFakeApi, MANIFEST } from './backend-fake-api.mjs';

function setup(opts = {}, statuses = {}) {
    const api = makeFakeApi({ allowClose: true, ...opts });
    const store = createStore(api);
    createAttention(api, store);
    store.workspaceID = 'ws1';
    store.settings = { ...store.settings, manifestDir: '/m', worktreeRoots: ['/wt'] };
    store.manifestWorkers = MANIFEST.workers;
    store.orchestrator = { paneID: 'orch', label: 'coordinator', source: 'manifest' };
    for (const id of ['orch', 'w1', 'w2']) {
        applyStateChange(store, { kind: 'pane-upserted', workspaceID: 'ws1', paneID: id, pane: { id, status: statuses[id] ?? 'idle', workingDirectory: `/wt/${id}` } });
    }
    return { api, store };
}

test('clear-done closes every finished worker and never the orchestrator', async () => {
    const { api, store } = setup({ gitStatus: { '/wt/w1': { kind: 'clean' } } });
    store.resultExists.set('w1', true);
    store.resultExists.set('w2', true);
    const result = await clearDone(api, store);
    assert.deepEqual(result, { ok: true, cleared: ['w1', 'w2'], kept: [] });
    assert.deepEqual(api.callsTo('panes.close').map(c => c.args), [['w1'], ['w2']]);
    assert.ok(store.archived.has('w1') && store.archived.has('w2'));
});

test('clear-done leaves running workers alone', async () => {
    const { api, store } = setup({}, { w1: 'running' });
    store.resultExists.set('w2', true);
    const result = await clearDone(api, store);
    assert.deepEqual(result.cleared, ['w2']);
    assert.deepEqual(api.callsTo('panes.close').map(c => c.args), [['w2']]);
    assert.equal(store.archived.has('w1'), false);
});

test('clear-done keeps a worker with a dirty worktree, clears the rest, and names the kept one', async () => {
    const { api, store } = setup({ gitStatus: { '/wt/w1': { kind: 'dirty', changedFiles: 3 } } });
    store.resultExists.set('w1', true);
    store.resultExists.set('w2', true);
    const result = await clearDone(api, store);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'PARTIAL');
    assert.deepEqual(result.cleared, ['w2']);
    assert.deepEqual(result.kept.map(k => [k.paneID, k.code]), [['w1', 'DIRTY']]);
    assert.match(result.error, /cleared 1, kept 1: repo-lag \(worktree \/wt\/w1 has uncommitted changes/);
    assert.equal(store.archived.has('w1'), false);
});

test('clear-done dismisses a finished worker whose pane is already closed, without closing anything', async () => {
    const { api, store } = setup();
    store.resultExists.set('w2', true);
    applyStateChange(store, { kind: 'pane-removed', workspaceID: 'ws1', paneID: 'w2' });
    const result = await clearDone(api, store);
    assert.deepEqual(result.cleared, ['w2']);
    assert.equal(api.callsTo('panes.close').length, 0);
    assert.ok(store.archived.has('w2'));
});

test('clear-done with nothing finished is a no-op', async () => {
    const { api, store } = setup({}, { w1: 'running', w2: 'running' });
    assert.deepEqual(await clearDone(api, store), { ok: true, cleared: [], kept: [] });
    assert.equal(api.callsTo('panes.close').length, 0);
});
