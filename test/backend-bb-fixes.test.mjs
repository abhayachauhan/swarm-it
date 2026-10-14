// Fixes seen live in a second swarm (workspace BB): the coordinator row, hide retries, the Workers workspace's shell pane.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSwarmApi } from './backend-fake-api.mjs';

// Set before the backend loads: it reads the scan interval and the hide retry delays once.
process.env.SWARM_PROMPT_SCAN_MS = '20';
process.env.SWARM_HIDE_RETRY_MS = '40,80';
const { registerAll, SNAPSHOT_EVENT, HIDE_RETRY_MS } = await import('../backend/index.mjs');
const lastSnapshot = api => api.emitted.filter(e => e.name === SNAPSHOT_EVENT).at(-1)?.data;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const moved = api => api.callsTo('panes.moveToWorkspace').map(c => c.args[0]).sort();

test('open-thread on the coordinator closes the thread view this plugin opened, returns ok and raises no warning', async () => {
    const api = makeSwarmApi({ allowClose: true, files: { '/wt/w1/result.md': '## Goal\nG\n' } });
    const dispose = registerAll(api);
    await dispose.ready;
    const nothingOpen = await api.command('open-thread', { paneID: 'orch' });
    assert.deepEqual(nothingOpen, { ok: true, orchestrator: true, closedViewPaneID: null }, 'ok even when no thread is open');
    assert.equal(api.callsTo('panes.close').length, 0);
    assert.equal((await api.command('open-thread', { paneID: 'w1' })).ok, true);
    const back = await api.command('open-thread', { paneID: 'orch' });
    assert.deepEqual(back, { ok: true, orchestrator: true, closedViewPaneID: 'view-pane' });
    assert.deepEqual(api.callsTo('panes.close').map(c => c.args), [['view-pane']], 'only the thread pane it opened');
    assert.equal(api.callsTo('openView').length, 1, 'no thread view is opened for the coordinator');
    const { snapshot } = await api.command('get-state', {});
    assert.deepEqual(snapshot.warnings, [], 'the coordinator row never surfaces a warning');
    assert.equal((await api.command('open-thread', { paneID: 'orch' })).closedViewPaneID, null, 'the closed pane is forgotten');
    assert.equal(api.callsTo('panes.close').length, 1);
    assert.equal((await api.command('open-thread', { paneID: 'stranger' })).code, 'NOT_WORKER', 'other panes are still refused');
    dispose();
});

test('a failed hide is retried with backoff and the collapse warning clears once the move works', async () => {
    assert.deepEqual(HIDE_RETRY_MS, [40, 80]);
    const api = makeSwarmApi({ createFails: true });
    const dispose = registerAll(api);
    await dispose.ready;
    assert.equal(api.callsTo('workspaces.create').length, 2, 'one attempt per worker on the first pass');
    assert.deepEqual(moved(api), []);
    assert.ok(lastSnapshot(api).warnings.some(w => w === 'collapse: cannot create the Workers workspace: plugin invocation has expired'), lastSnapshot(api).warnings.join(' | '));
    const { snapshot } = await api.command('get-state', {});
    assert.ok(snapshot.warnings.some(w => /^autohide: repo-lag: move failed, retrying in \d+ s; tests: move failed, retrying in \d+ s$/.test(w)), snapshot.warnings.join(' | '));
    assert.equal(api.callsTo('workspaces.create').length, 2, 'not retried before the first delay');
    await sleep(60);
    assert.ok(api.callsTo('workspaces.create').length >= 4, 'retried after the first delay');
    const afterSecond = api.callsTo('workspaces.create').length;
    api.createFails = false;
    await sleep(15);
    assert.equal(api.callsTo('workspaces.create').length, afterSecond, 'the second delay is longer than the first');
    await sleep(120);
    assert.deepEqual(moved(api), ['w1', 'w2'], 'the retry moved both workers');
    const warnings = lastSnapshot(api).warnings;
    assert.equal(warnings.some(w => w.startsWith('collapse:')), false, warnings.join(' | '));
    assert.equal(warnings.some(w => /retrying/.test(w)), false, warnings.join(' | '));
    dispose();
});

test('the shell pane the host opens in the new Workers workspace is kept, so the workspace never empties and is never recreated', async () => {
    const api = makeSwarmApi({ allowClose: true, createShellPane: true });
    const dispose = registerAll(api);
    await dispose.ready;
    assert.deepEqual(moved(api), ['w1', 'w2']);
    await sleep(60);
    assert.deepEqual(api.callsTo('panes.close'), []);
    assert.deepEqual(api.destructive, []);
    dispose();
});
