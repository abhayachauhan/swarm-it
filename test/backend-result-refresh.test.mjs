// A worker whose result file lands with no pane event after it (the agent already reported waiting) still turns done.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSwarmApi } from './backend-fake-api.mjs';

process.env.SWARM_PROMPT_SCAN_MS = '20';
const { registerAll } = await import('../backend/index.mjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const stateOf = async (api, paneID) => (await api.command('get-state', { workspaceID: 'ws1' })).snapshot.workers.find(w => w.paneID === paneID)?.state;

test('a waiting worker turns done once its result file exists, without another pane event', async () => {
    const api = makeSwarmApi({ w1Status: 'waitingForInput' });
    const dispose = registerAll(api);
    await dispose.ready;
    assert.equal(await stateOf(api, 'w1'), 'waiting');
    api.fileStore['/wt/w1/result.md'] = '## Goal\nfix lag\n## Done\n- fixed';
    await sleep(80);
    assert.equal(await stateOf(api, 'w1'), 'done', 'the scan rechecks the result of a worker that is not done');
    dispose();
});
