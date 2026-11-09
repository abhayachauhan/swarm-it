import { hideWorker, showWorker } from '../backend/collapse.mjs';
import { ensureWorkersWorkspace } from '../backend/workers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerAll } from '../backend/index.mjs';
import { createStore, seedFromSnapshot, applyStateChange, otherSwarmPane, load } from '../backend/store.mjs';
import { makeSwarmApi, makeFakeApi, MANIFEST } from './backend-fake-api.mjs';

const childOf = (api, pane) => api.workspaceList.find(w => w.id === api.paneList.find(p => p.id === pane).workspaceID);

test('existing shared workers migrate to separate children without moving a coordinator or an unlisted pane', async t => {
    const api = makeSwarmApi({ otherWorkspaces: [{ id: 'shared', name: 'Workers' }], otherPanes: [{ id: 'unlisted', workspaceID: 'shared' }] });
    for (const id of ['w1', 'w2']) api.paneList.find(p => p.id === id).workspaceID = 'shared';
    const dispose = registerAll(api);
    t.after(dispose);
    await dispose.ready;
    assert.equal(childOf(api, 'w1').parentID, 'ws1');
    assert.equal(childOf(api, 'w2').parentID, 'ws1');
    assert.notEqual(childOf(api, 'w1').id, childOf(api, 'w2').id);
    assert.equal(childOf(api, 'orch').id, 'ws1');
    assert.equal(childOf(api, 'unlisted').id, 'shared');
    assert.deepEqual(api.callsTo('panes.close'), []);
    assert.deepEqual(api.callsTo('groups.create'), []);
    assert.ok(api.callsTo('panes.moveToWorkspace').every(c => c.args[2].focus === false));
});

test('following a worker child shows its coordinator swarm; a foreign child is refused even with a matching name', async t => {
    const api = makeSwarmApi({
        settings: { autoHide: false },
        otherWorkspaces: [{ id: 'child', name: 'repo-lag', parentID: 'ws1' }, { id: 'foreign', name: 'tests', parentID: 'elsewhere' }]
    });
    api.paneList.find(p => p.id === 'w1').workspaceID = 'child';
    api.paneList.find(p => p.id === 'w2').workspaceID = 'foreign';
    const dispose = registerAll(api);
    t.after(dispose);
    await dispose.ready;
    const { snapshot } = await api.command('get-state', { workspaceID: 'child' });
    assert.equal(snapshot.workspaceID, 'ws1');
    assert.deepEqual(snapshot.workers.map(w => w.paneID), ['w1']);
    assert.equal((await api.command('capture-worker', { paneID: 'w2' })).code, 'NOT_WORKER');
    assert.equal(childOf(api, 'w2').id, 'foreign');
    assert.deepEqual(api.callsTo('panes.moveToWorkspace'), []);
    assert.deepEqual(api.callsTo('workspaces.create'), []);
});

test('host childOrder snapshots and reparent events update ownership for other-swarm requests', () => {
    const store = createStore({});
    seedFromSnapshot(store, { state: { workspaces: [
        { id: 'ws1', name: 'Home', childOrder: ['child'], panes: [{ id: 'orch' }] },
        { id: 'child', name: 'Worker', childOrder: [], panes: [{ id: 'w1' }] },
        { id: 'other', name: 'Other', childOrder: [], panes: [] }
    ] } });
    store.swarms = [{ workspaceID: 'ws1', name: 'Home', orchestrator: { paneID: 'orch' }, workers: [{ paneID: 'w1', label: 'Worker' }] }];
    assert.equal(otherSwarmPane(store, 'w1')?.swarm.workspaceID, 'ws1');
    applyStateChange(store, { kind: 'workspace-upserted', workspace: { id: 'ws1', name: 'Home', childOrder: [] } });
    applyStateChange(store, { kind: 'workspace-upserted', workspace: { id: 'other', name: 'Other', childOrder: ['child'] } });
    assert.equal(otherSwarmPane(store, 'w1'), null);
    assert.equal(store.panes.get('w1').workspaceID, 'child');
});

// Migration failure and cleanup use the real store/collapse code against a host with initial shells.

async function migrationFixture() {
    const api = makeFakeApi({ workspaces: [{ id: 'ws1', name: 'Swarm' }, { id: 'personal', name: 'My empty child', parentID: 'ws1' }], panes: [{ id: 'orch', workspaceID: 'ws1' }, { id: 'w1', workspaceID: 'ws1', status: 'running' }], allowClose: true, removeClosedPanes: true, createShellPane: true });
    const store = createStore(api);
    store.workspaceID = 'ws1'; store.workspaceName = 'Swarm'; store.manifestWorkers = [MANIFEST.workers[0]];
    seedFromSnapshot(store, await api.snapshot());
    return { api, store };
}

test('a failed move preserves both panes, then reuses one child after reload and closes only its seed shell', async () => {
    const { api, store } = await migrationFixture();
    const move = api.panes.moveToWorkspace;
    api.panes.moveToWorkspace = async () => { throw new Error('move blocked'); };
    assert.deepEqual(await hideWorker(api, store, 'w1'), { ok: false, error: 'move failed: move blocked', code: 'MOVE_FAILED' });
    assert.equal(store.panes.get('w1').workspaceID, 'ws1');
    assert.deepEqual(api.callsTo('panes.close'), []);
    const next = createStore(api); next.workspaceID = 'ws1'; next.manifestWorkers = [MANIFEST.workers[0]];
    await load(next); seedFromSnapshot(next, await api.snapshot());
    api.panes.moveToWorkspace = move;
    assert.equal((await hideWorker(api, next, 'w1')).ok, true);
    assert.equal(api.callsTo('workspaces.create').length, 1);
    assert.deepEqual(api.callsTo('panes.close').map(c => c.args[0]), ['shell-ws-created-1']);
    assert.equal(api.paneList.find(p => p.id === 'w1').status, 'running');
    assert.equal((await showWorker(api, next, 'w1')).ok, true);
    assert.deepEqual(api.callsTo('workspaces.remove').map(c => c.args[0]), ['ws-created-1']);
    assert.equal(next.workerWorkspaces.size, 0);
    assert.ok(api.workspaceList.some(w => w.id === 'personal'));
});

test('a seed shell with new activity or an agent is preserved', async () => {
    for (const changed of [{ lastActivityAt: 2 }, { agentSessionID: 'new-session' }]) {
        const { api, store } = await migrationFixture();
        const move = api.panes.moveToWorkspace;
        api.panes.moveToWorkspace = async (...args) => { Object.assign(api.paneList.find(p => p.id === 'shell-ws-created-1'), changed); return move(...args); };
        assert.equal((await hideWorker(api, store, 'w1')).ok, true);
        assert.deepEqual(api.callsTo('panes.close'), []);
        assert.equal(api.paneList.find(p => p.id === 'w1').status, 'running');
    }
});

test('unsupported nesting after creation removes the untouched orphan and blocks repeated creation', async () => {
    const { api, store } = await migrationFixture();
    const create = api.workspaces.create;
    api.workspaces.create = async options => { const result = await create(options); throw Object.assign(new Error('nesting unsupported'), { code: 'UNSUPPORTED', details: result }); };
    const first = await hideWorker(api, store, 'w1');
    assert.deepEqual(first, { ok: false, code: 'UNSUPPORTED', error: 'cannot create the worker child workspace: nesting unsupported' });
    assert.equal((await hideWorker(api, store, 'w1')).code, 'CREATE_BLOCKED');
    assert.equal(api.callsTo('workspaces.create').length, 1);
    assert.deepEqual(api.callsTo('workspaces.remove').map(c => c.args[0]), ['ws-created-1']);
    assert.equal(store.panes.get('w1').workspaceID, 'ws1');
    assert.equal(api.callsTo('panes.moveToWorkspace').length, 0);
});

test('a sub-coordinator keeps its own rail and its workers migrate into root siblings', async t => {
    const api = makeSwarmApi({
        otherWorkspaces: [{ id: 'sub', name: 'Sub swarm', parentID: 'ws1' }],
        otherPanes: [{ id: 'sub-orch', label: 'coordinator', workspaceID: 'sub' }, { id: 'sub-worker', label: 'Sub worker', workspaceID: 'sub', status: 'running' }],
        files: { '/m/sub.json': JSON.stringify({ version: 1, orchestrator: { paneID: 'sub-orch', label: 'coordinator' }, workers: [{ paneID: 'sub-worker', label: 'Sub worker', task: 'work', resultPath: null, worktreePath: null, parent: null }] }) }
    });
    const dispose = registerAll(api); t.after(dispose); await dispose.ready;
    const { snapshot } = await api.command('get-state', { workspaceID: 'sub' });
    assert.equal(snapshot.workspaceID, 'sub');
    assert.deepEqual(snapshot.workers.map(w => w.paneID), ['sub-worker']);
    assert.equal(childOf(api, 'sub-worker').parentID, 'ws1');
    assert.notEqual(childOf(api, 'sub-worker').id, 'sub');
    assert.equal(childOf(api, 'sub-orch').id, 'sub');
    assert.equal((await api.command('get-state', { workspaceID: childOf(api, 'sub-worker').id })).snapshot.workspaceID, 'sub');
});

test('a focused worker stays in place until the user navigates away', async t => {
    const api = makeSwarmApi();
    Object.assign(api.paneList.find(p => p.id === 'w1'), { isFocused: true, isActiveWorkspace: true });
    const dispose = registerAll(api); t.after(dispose); await dispose.ready;
    assert.equal(childOf(api, 'w1').id, 'ws1');
    assert.equal(api.callsTo('panes.moveToWorkspace').some(c => c.args[0] === 'w1'), false);
    await api.upsert('w1', { isFocused: false, isActiveWorkspace: false });
    assert.equal(childOf(api, 'w1').parentID, 'ws1');
});

test('concurrent placement requests create one child, and a deleted saved child is replaced once', async () => {
    const { api, store } = await migrationFixture();
    const worker = store.manifestWorkers[0];
    const [a, b] = await Promise.all([ensureWorkersWorkspace(api, store, worker), ensureWorkersWorkspace(api, store, worker)]);
    assert.equal(a.workspaceID, b.workspaceID);
    assert.equal(api.callsTo('workspaces.create').length, 1);
    await api.workspaces.remove(a.workspaceID);
    api.paneList.splice(api.paneList.findIndex(p => p.id.startsWith('shell-')), 1);
    assert.equal((await hideWorker(api, store, 'w1')).ok, true);
    assert.equal(api.callsTo('workspaces.create').length, 2);
    assert.notEqual(store.panes.get('w1').workspaceID, a.workspaceID);
});

test('a manifest cannot claim a sibling sub-coordinator as its worker', () => {
    const store = createStore({});
    seedFromSnapshot(store, { state: { workspaces: [
        { id: 'root', name: 'Root', childOrder: ['sub1', 'sub2'], panes: [] },
        { id: 'sub1', name: 'First', childOrder: [], panes: [{ id: 'orch1' }] },
        { id: 'sub2', name: 'Second', childOrder: [], panes: [{ id: 'orch2' }] }
    ] } });
    store.swarms = [
        { workspaceID: 'sub1', name: 'First', orchestrator: { paneID: 'orch1' }, workers: [{ paneID: 'orch2', label: 'stolen' }] },
        { workspaceID: 'sub2', name: 'Second', orchestrator: { paneID: 'orch2' }, workers: [] }
    ];
    assert.equal(otherSwarmPane(store, 'orch2')?.swarm.workspaceID, 'sub2');
    assert.equal(store.panes.get('orch2').workspaceID, 'sub2');
});


test('a coordinator in the old Workers workspace is still discovered while another workspace is followed', async t => {
    const api = makeSwarmApi({ otherWorkspaces: [{ id: 'ws3', name: 'Elsewhere' }] });
    api.workspaceList.find(w => w.id === 'ws1').name = 'Workers';
    const dispose = registerAll(api); t.after(dispose); await dispose.ready;
    const { snapshot } = await api.command('get-state', { workspaceID: 'ws3' });
    assert.equal(snapshot.workspaceID, 'ws3');
    assert.ok(snapshot.otherSwarms.some(s => s.workspaceID === 'ws1'));
    assert.equal(childOf(api, 'w1').parentID, 'ws1');
    assert.equal(childOf(api, 'orch').id, 'ws1');
});
