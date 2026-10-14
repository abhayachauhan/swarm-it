// A first install can find dozens of workers to move. Each move brings a burst of host events, and Kelpi stops a
// plugin that sends over 512 messages a second, so moves are spread over scans (BATCH_PER_SCAN per scan).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSwarmApi } from './backend-fake-api.mjs';

process.env.SWARM_PROMPT_SCAN_MS = '150';
process.env.SWARM_SWARMS_RELOAD_MS = '10';
const { registerAll } = await import('../backend/index.mjs');
const { BATCH_PER_SCAN } = await import('../backend/workers.mjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('another swarm\'s 20 workers in its old workspace move to Workers a batch per scan', async () => {
    const ids = Array.from({ length: 20 }, (_, n) => `x${n}`);
    const manifest = {
        version: 1,
        orchestrator: { paneID: 'orch2', label: 'coordinator' },
        workers: ids.map(id => ({ paneID: id, label: id, task: 't', resultPath: null, worktreePath: null, parent: null }))
    };
    const api = makeSwarmApi({
        otherWorkspaces: [{ id: 'ws2', name: 'Agents' }, { id: 'old', name: 'Agents · workers' }],
        otherPanes: [{ id: 'orch2', label: 'coordinator', workspaceID: 'ws2' }, ...ids.map(id => ({ id, label: id, workspaceID: 'old', status: 'running' }))],
        files: { '/m/ws2.json': JSON.stringify(manifest) },
        captures: Object.fromEntries([['orch2', ''], ...ids.map(id => [id, 'working'])])
    });
    const dispose = registerAll(api);
    await dispose.ready;
    await api.command('get-state', { workspaceID: 'ws1' });
    const movedOthers = () => api.callsTo('panes.moveToWorkspace').filter(c => ids.includes(c.args[0])).length;
    for (let n = 0; n < 100 && movedOthers() === 0; n += 1) await sleep(5);
    await sleep(40);
    assert.equal(movedOthers(), BATCH_PER_SCAN, 'one batch in the first scan');
    for (let n = 0; n < 200 && movedOthers() < 20; n += 1) await sleep(10);
    assert.equal(movedOthers(), 20, 'the rest follow on the next scans');
    const shared = api.workspaceList.find(w => w.name === 'Workers');
    assert.ok(ids.every(id => api.paneList.find(p => p.id === id).workspaceID === shared.id));
    dispose();
});
