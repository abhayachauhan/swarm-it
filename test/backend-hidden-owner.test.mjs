// The saved workers workspace belongs to one swarm. After a reload it must not be reused for, or moved into the Group of, another.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSwarmApi } from './backend-fake-api.mjs';

process.env.SWARM_PROMPT_SCAN_MS = '20';
const { registerAll } = await import('../backend/index.mjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a saved workers workspace of another swarm is not moved into the followed swarm\'s Group', async () => {
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
    assert.equal(group('wsH'), 'gB', 'the other swarm\'s workers workspace stays in its own Group');
    const own = api.workspaceList.find(w => w.name === 'Swarm · workers');
    assert.ok(own, 'the followed swarm gets its own workers workspace');
    assert.equal(own.groupID, 'gA');
    const where = id => api.paneList.find(p => p.id === id)?.workspaceID;
    assert.equal(where('w1'), own.id, 'workers move into their own swarm\'s workers workspace');
    dispose();
});
