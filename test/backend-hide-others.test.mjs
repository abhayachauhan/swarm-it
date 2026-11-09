import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSwarmApi } from './backend-fake-api.mjs';

// Set before the backend loads: it reads the scan and swarm reload intervals once.
process.env.SWARM_PROMPT_SCAN_MS = '20';
process.env.SWARM_SWARMS_RELOAD_MS = '10';
process.env.SWARM_CAPTURE_TIMEOUT_MS = '50';
const { registerAll } = await import('../backend/index.mjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const AGENTS = {
    version: 1,
    orchestrator: { paneID: 'orch2', label: 'coordinator' },
    workers: [
        { paneID: 'x1', label: 'one', task: 'a', resultPath: null, worktreePath: null, parent: null },
        { paneID: 'x2', label: 'two', task: 'b', resultPath: null, worktreePath: null, parent: null },
        { paneID: 'x3', label: 'moved-away', task: 'c', resultPath: null, worktreePath: null, parent: null }
    ]
};

/** ws1 is the followed swarm; ws2 ("Agents", in Group g1) is another live swarm whose workers sit in ws2. */
function makeApi(extra = {}) {
    return makeSwarmApi({
        otherWorkspaces: [{ id: 'ws2', name: 'Agents', groupID: 'g1' }, { id: 'ws3', name: 'Mine' }, ...(extra.workspaces ?? [])],
        otherPanes: [
            { id: 'orch2', label: 'coordinator', workspaceID: 'ws2' },
            { id: 'x1', label: 'one', workspaceID: 'ws2', status: 'running' },
            { id: 'x2', label: 'two', workspaceID: 'ws2', status: 'running' },
            { id: 'x3', label: 'moved-away', workspaceID: 'ws3', status: 'running' },
            { id: 'y1', label: 'not-listed', workspaceID: 'ws2' }
        ],
        files: { '/m/ws2.json': JSON.stringify(AGENTS) },
        captures: { orch2: '', x1: 'working', x2: 'working', x3: 'working', y1: '$' },
        allowClose: true,
        createShellPane: true,
        ...extra
    });
}
const workspaceOf = (api, id) => api.paneList.find(p => p.id === id)?.workspaceID;

test('another live swarm\'s workers are hidden without the user opening its workspace', async () => {
    const api = makeApi();
    const dispose = registerAll(api);
    await dispose.ready;
    await api.command('get-state', { workspaceID: 'ws1' });
    await sleep(100);
    const children = api.workspaceList.filter(w => w.parentID);
    assert.equal(children.filter(w => w.parentID === 'ws1').length, 2);
    assert.equal(children.filter(w => w.parentID === 'ws2').length, 2);
    for (const id of ['w1', 'w2', 'x1', 'x2']) {
        assert.equal(children.find(w => w.id === workspaceOf(api, id)).parentID, id.startsWith('w') ? 'ws1' : 'ws2');
    }
    assert.equal(new Set(['w1', 'w2', 'x1', 'x2'].map(id => workspaceOf(api, id))).size, 4);
    // Never moved: the coordinator, a pane not in the manifest, and a worker the user put somewhere else.
    assert.equal(workspaceOf(api, 'orch2'), 'ws2');
    assert.equal(workspaceOf(api, 'y1'), 'ws2');
    assert.equal(workspaceOf(api, 'x3'), 'ws3');
    assert.deepEqual(api.callsTo('panes.close').map(c => c.args[0]), ['shell-ws-created-1', 'shell-ws-created-2', 'shell-ws-created-3', 'shell-ws-created-4'], 'only untouched plugin-created shells close');
    assert.equal(api.callsTo('workspaces.create').length, 4, 'one per worker');
    dispose();
});

test('an existing shared Workers workspace is left alone, and nothing moves with auto-hide off', async () => {
    const api = makeApi({ workspaces: [{ id: 'ws9', name: 'Workers' }] });
    const dispose = registerAll(api);
    await dispose.ready;
    await sleep(100);
    assert.notEqual(workspaceOf(api, 'x1'), 'ws9');
    assert.equal(api.workspaceList.find(w => w.id === workspaceOf(api, 'x1')).parentID, 'ws2');
    assert.equal(api.callsTo('workspaces.create').length, 4);
    dispose();

    const off = makeApi({ settings: { autoHide: false } });
    const disposeOff = registerAll(off);
    await disposeOff.ready;
    await sleep(100);
    assert.equal(workspaceOf(off, 'x1'), 'ws2');
    assert.equal(off.callsTo('panes.moveToWorkspace').length, 0);
    disposeOff();
});
