// A saved workers workspace id from before the shared Workers workspace points at one swarm's old `<name> · workers`.
// After a reload it must not be reused for another swarm: workers go to the shared Workers workspace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSwarmApi } from './backend-fake-api.mjs';

process.env.SWARM_PROMPT_SCAN_MS = '20';
const { registerAll } = await import('../backend/index.mjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a saved old workers workspace of another swarm is not reused: workers move to the shared Workers workspace', async () => {
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
    const shared = api.workspaceList.find(w => w.name === 'Workers');
    assert.ok(shared, 'the shared Workers workspace is created');
    const where = id => api.paneList.find(p => p.id === id)?.workspaceID;
    assert.equal(where('w1'), shared.id);
    assert.equal(where('w2'), shared.id);
    assert.equal(where('orch'), 'ws1', 'the coordinator stays');
    dispose();
});
