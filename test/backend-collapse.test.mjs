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

test('ensureHiddenWorkspace creates one shared "Workers" workspace in a new collapsed "Workers" Group, once (acceptance 9)', async () => {
    const { api, store } = setup();
    const first = await ensureHiddenWorkspace(api, store, store.settings);
    assert.equal(first.ok, true);
    const [group] = api.callsTo('groups.create');
    assert.equal(group.args[0], 'Workers');
    const created = api.workspaceList.find(w => w.id === first.workspaceID);
    assert.equal(created.name, 'Workers');
    assert.equal(created.groupID, 'g-created-1');
    assert.deepEqual(api.callsTo('groups.setCollapsed').map(c => c.args), [['g-created-1', true]]);
    const second = await ensureHiddenWorkspace(api, store, store.settings);
    assert.equal(second.workspaceID, first.workspaceID);
    assert.equal(api.callsTo('workspaces.create').length, 1, 'not created twice');
    assert.equal(api.storageMap.get('hiddenWorkspaceID'), first.workspaceID);
    assert.equal(api.destructive.length, 0, 'the shell pane the host opens in it is kept');
});

test('ensureHiddenWorkspace reuses the existing Workers workspace, preferring the one in the Workers Group; never an old "<name> · workers"', async () => {
    const { api, store } = setup({
        workspaces: [{ id: 'ws1', name: 'Swarm' }, { id: 'old', name: 'Swarm · workers' }, { id: 'loose', name: 'Workers' }, { id: 'shared', name: 'Workers', groupID: 'gW' }],
        groups: [{ id: 'gW', name: 'Workers', workspaces: [] }]
    });
    assert.equal((await ensureHiddenWorkspace(api, store, store.settings)).workspaceID, 'shared');
    assert.equal(api.callsTo('workspaces.create').length, 0);
    assert.equal(api.callsTo('groups.create').length, 0);
});

test('without a Group API the Workers workspace is still created, at the top level', async () => {
    const { api, store } = setup();
    delete api.groups;
    const result = await ensureHiddenWorkspace(api, store, store.settings);
    assert.equal(result.ok, true);
    assert.deepEqual(api.callsTo('workspaces.create')[0].args[0], { name: 'Workers' });
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
