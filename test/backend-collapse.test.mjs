import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, applyStateChange } from '../backend/store.mjs';
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

test('ensureHiddenWorkspace creates "<name> · workers" once and remembers it (acceptance 9)', async () => {
    const { api, store } = setup();
    const first = await ensureHiddenWorkspace(api, store, store.settings);
    assert.equal(first.ok, true);
    assert.equal(api.callsTo('workspaces.create')[0].args[0].name, 'Swarm · workers');
    const second = await ensureHiddenWorkspace(api, store, store.settings);
    assert.equal(second.workspaceID, first.workspaceID);
    assert.equal(api.callsTo('workspaces.create').length, 1, 'not created twice');
    assert.equal(api.storageMap.get('hiddenWorkspaceID'), first.workspaceID);
});

test('ensureHiddenWorkspace reuses an existing workspace with that name', async () => {
    const { api, store } = setup({ workspaces: [{ id: 'ws1', name: 'Swarm' }, { id: 'old', name: 'Swarm · workers' }] });
    assert.equal((await ensureHiddenWorkspace(api, store, store.settings)).workspaceID, 'old');
    assert.equal(api.callsTo('workspaces.create').length, 0);
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
