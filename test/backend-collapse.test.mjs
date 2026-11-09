import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, applyStateChange, load } from '../backend/store.mjs';
import { ensureHiddenWorkspace, hideWorker, showWorker } from '../backend/collapse.mjs';
import { makeFakeApi, MANIFEST } from './backend-fake-api.mjs';

function setup(opts = {}) {
    const api = makeFakeApi({ workspaces: [{ id: 'ws1', name: 'Swarm' }], ...opts });
    const store = createStore(api);
    store.workspaceID = 'ws1';
    store.workspaceName = 'Swarm';
    store.manifestWorkers = MANIFEST.workers;
    for (const id of ['orch', 'w1', 'w2', 'stranger']) {
        applyStateChange(store, { kind: 'pane-upserted', workspaceID: 'ws1', paneID: id, pane: { id, status: 'running' } });
    }
    return { api, store };
}

test('each worker gets a separate child workspace, reused across retry and reload, without a Workers group', async () => {
    const { api, store } = setup();
    const first = await ensureHiddenWorkspace(api, store, store.settings, 'w1');
    const second = await ensureHiddenWorkspace(api, store, store.settings, 'w2');
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.notEqual(first.workspaceID, second.workspaceID);
    assert.deepEqual(api.callsTo('workspaces.create').map(c => c.args[0]), MANIFEST.workers.map(w => ({ name: w.label, parentID: 'ws1', focus: false })));
    assert.deepEqual(api.callsTo('groups.create'), []);
    assert.equal((await ensureHiddenWorkspace(api, store, store.settings, 'w1')).workspaceID, first.workspaceID);
    const loaded = createStore(api);
    loaded.workspaceID = 'ws1';
    loaded.manifestWorkers = MANIFEST.workers;
    await load(loaded);
    assert.equal((await ensureHiddenWorkspace(api, loaded, loaded.settings, 'w1')).workspaceID, first.workspaceID);
    assert.equal(api.callsTo('workspaces.create').length, 2);
    assert.equal(api.destructive.length, 0);
});

test('a shared Workers workspace and same-named children of another parent are never reused', async () => {
    const { api, store } = setup({ workspaces: [{ id: 'ws1', name: 'Swarm' }, { id: 'shared', name: 'Workers' }, { id: 'other', name: 'repo-lag', parentID: 'ws2' }] });
    const result = await hideWorker(api, store, 'w1');
    assert.equal(result.ok, true);
    assert.deepEqual(api.callsTo('workspaces.create')[0].args[0], { name: 'repo-lag', parentID: 'ws1', focus: false });
    assert.deepEqual(api.callsTo('panes.moveToWorkspace')[0].args, ['w1', result.workspaceID, { focus: false }]);
    assert.equal(store.panes.get('stranger').workspaceID, 'ws1');
});

test('hideWorker moves a manifest worker with moveToWorkspace by pane id', async () => {
    const { api, store } = setup();
    const result = await hideWorker(api, store, 'w1');
    assert.equal(result.ok, true);
    const [move] = api.callsTo('panes.moveToWorkspace');
    assert.deepEqual(move.args.slice(0, 2), ['w1', result.workspaceID]);
    assert.equal(store.panes.get('w1').workspaceID, result.workspaceID);
    assert.equal((await hideWorker(api, store, 'w1')).moved, false, 'already hidden: no second move');
    assert.equal(api.callsTo('panes.moveToWorkspace').length, 1);
});

test('collapse only touches manifest workers, never the orchestrator or unknown panes', async () => {
    const { api, store } = setup();
    for (const id of ['orch', 'stranger', 'ghost']) {
        const result = await hideWorker(api, store, id);
        assert.deepEqual([result.ok, result.code], [false, 'NOT_MANIFEST_WORKER'], id);
        assert.equal((await showWorker(api, store, id)).code, 'NOT_MANIFEST_WORKER', id);
    }
    assert.equal(api.callsTo('panes.moveToWorkspace').length, 0);
    assert.equal(api.callsTo('workspaces.create').length, 0, 'no workspace is created for a refused pane');
});

test('showWorker restores the worker to the swarm workspace and stops auto-hiding it', async () => {
    const { api, store } = setup();
    await hideWorker(api, store, 'w1');
    const result = await showWorker(api, store, 'w1');
    assert.deepEqual(result, { ok: true, paneID: 'w1', workspaceID: 'ws1' });
    assert.deepEqual(api.callsTo('panes.moveToWorkspace')[1].args.slice(0, 2), ['w1', 'ws1']);
    assert.ok(store.restored.has('w1'));
    assert.deepEqual(api.storageMap.get('restored'), ['w1']);
});

test('turning collapse off disables it (autoHide false and collapse false)', async () => {
    for (const settings of [{ autoHide: false }, { collapse: false }]) {
        const { api, store } = setup();
        store.settings = { ...store.settings, ...settings };
        const result = await hideWorker(api, store, 'w1');
        assert.deepEqual([result.ok, result.code], [false, 'DISABLED']);
        assert.equal(api.callsTo('panes.moveToWorkspace').length, 0);
        assert.equal(api.callsTo('workspaces.create').length, 0);
    }
});

test('a failed move is reported and leaves the pane where it was', async () => {
    const { api, store } = setup();
    api.panes.moveToWorkspace = async () => { throw new Error('boom'); };
    const result = await hideWorker(api, store, 'w1');
    assert.deepEqual([result.ok, result.code], [false, 'MOVE_FAILED']);
    assert.equal(store.panes.get('w1').workspaceID, 'ws1');
});
