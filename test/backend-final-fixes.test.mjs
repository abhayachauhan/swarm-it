// A hide retry entry must not outlive its pane or the swarm the rail follows: otherwise settle and publish run every tick.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSwarmApi } from './backend-fake-api.mjs';

// Set before the backend loads: it reads the scan interval and the hide retry delays once.
process.env.SWARM_PROMPT_SCAN_MS = '20';
process.env.SWARM_HIDE_RETRY_MS = '30,30';
const { registerAll, SNAPSHOT_EVENT } = await import('../backend/index.mjs');
const snapshots = api => api.emitted.filter(e => e.name === SNAPSHOT_EVENT);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const collapse = api => snapshots(api).at(-1)?.data.warnings.filter(w => w.startsWith('collapse:')) ?? [];

async function failingHide(extra = {}) {
    const api = makeSwarmApi({ createFails: true, ...extra });
    const dispose = registerAll(api);
    await dispose.ready;
    assert.equal(api.callsTo('workspaces.create').length, 2, 'one attempt per worker on the first pass');
    assert.equal(collapse(api).length, 1, 'the failure is shown');
    return { api, dispose };
}

/** Over a quiet stretch nothing may be retried or published. */
async function assertQuiet(api, label, { backoff = false } = {}) {
    await sleep(30);
    const creates = api.callsTo('workspaces.create').length;
    const published = snapshots(api).length;
    await sleep(150);
    // A swarm the rail stops following is still hidden as another live swarm: its retries back off (30 ms here).
    if (backoff) assert.ok(api.callsTo('workspaces.create').length - creates <= 150 / 30, `${label}: retries back off`);
    else assert.equal(api.callsTo('workspaces.create').length, creates, `${label}: no retry`);
    assert.equal(snapshots(api).length, published, `${label}: no publish per tick`);
    assert.deepEqual(collapse(api), [], `${label}: the collapse warning cleared`);
}

test('a failed hide stops retrying and the warning clears once the pane is closed', async () => {
    const { api, dispose } = await failingHide();
    await api.fire('state.changed', { sequence: 500, data: [{ kind: 'pane-removed', workspaceID: 'ws1', paneID: 'w1' }, { kind: 'pane-removed', workspaceID: 'ws1', paneID: 'w2' }] });
    await assertQuiet(api, 'closed');
    dispose();
});

test('a failed hide is forgotten when the rail follows another workspace', async () => {
    const { api, dispose } = await failingHide({ otherWorkspaces: [{ id: 'ws3', name: 'Empty' }] });
    const { snapshot } = await api.command('get-state', { workspaceID: 'ws3' });
    assert.equal(snapshot.warnings.some(w => w.startsWith('collapse:')), false, snapshot.warnings.join(' | '));
    await assertQuiet(api, 'followed elsewhere', { backoff: true });
    dispose();
});

test('a failed hide keeps retrying while its pane is open', async () => {
    const { api, dispose } = await failingHide();
    await sleep(100);
    assert.ok(api.callsTo('workspaces.create').length > 2, 'retried');
    assert.equal(collapse(api).length, 1);
    dispose();
});
