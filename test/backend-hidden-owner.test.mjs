// A saved workers workspace id from before the shared Workers workspace points at one swarm's old `<name> · workers`.
// After a reload it must not be reused for another swarm: workers go to the shared Workers workspace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSwarmApi } from './backend-fake-api.mjs';

process.env.SWARM_PROMPT_SCAN_MS = '20';
const { registerAll } = await import('../backend/index.mjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a saved old workers workspace of another swarm is not reused: workers move to their own child workspaces', async () => {
    const storage = new Map([['hiddenWorkspaceID', 'wsH']]);
    const api = makeSwarmApi({
        swarmGroup: 'gA',
        otherWorkspaces: [{ id: 'wsO', name: 'Other', groupID: 'gB' }, { id: 'wsH', name: 'Other · workers', groupID: 'gB' }],
        storage
    });
    const dispose = registerAll(api);
    await dispose.ready;
    await sleep(100);
    const group = id => api.workspaceList.find(w => w.id === id)?.groupID;
    assert.equal(group('wsH'), 'gB', 'the other swarm\'s old workspace is left where it is');
    const children = api.workspaceList.filter(w => w.parentID === 'ws1');
    assert.equal(children.length, 2);
    assert.notEqual(children[0].id, children[1].id);
    const where = id => api.paneList.find(p => p.id === id)?.workspaceID;
    assert.equal(where('w1'), children.find(w => w.name === 'repo-lag').id);
    assert.equal(where('w2'), children.find(w => w.name === 'tests').id);
    assert.equal(where('orch'), 'ws1', 'the coordinator stays');
    dispose();
});
