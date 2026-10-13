// Fixes seen live in a second swarm (workspace BB): the coordinator row, hide retries, the created shell pane.
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
    assert.ok(lastSnapshot(api).warnings.some(w => w === 'collapse: cannot create the hidden workspace: plugin invocation has expired'), lastSnapshot(api).warnings.join(' | '));
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

test('the empty shell pane made by creating the workers workspace is closed once a worker moved in, and only that one', async () => {
    const api = makeSwarmApi({ allowClose: true, createShellPane: true });
    const dispose = registerAll(api);
    await dispose.ready;
    assert.deepEqual(moved(api), ['w1', 'w2']);
    assert.deepEqual(api.callsTo('panes.close').map(c => c.args), [['shell-ws-created-1']]);
    assert.equal(dispose.store.hiddenShellPaneID, null, 'forgotten once closed');
    // A pane the user opens in the workers workspace later is never closed.
    await api.upsert('user-pane', { workspaceID: 'ws-created-1', status: 'idle' });
    await sleep(60);
    assert.equal(api.callsTo('panes.close').length, 1);
    assert.deepEqual(api.destructive, []);
    dispose();
});

test('a shell pane announced only after the workspace was created is still closed; one outside the window is not', async () => {
    const api = makeSwarmApi({ allowClose: true });
    const dispose = registerAll(api);
    await dispose.ready;
    assert.equal(dispose.store.hiddenShellPaneID, null, 'the listing showed no pane');
    assert.equal(dispose.store.createdHiddenWorkspaceID, 'ws-created-1');
    await api.upsert('late-shell', { workspaceID: 'ws-created-1', status: 'idle' });
    assert.deepEqual(api.callsTo('panes.close').map(c => c.args), [['late-shell']]);
    assert.equal(dispose.store.createdHiddenWorkspaceID, null, 'the creation window is over');
    await api.upsert('another', { workspaceID: 'ws-created-1', status: 'idle' });
    assert.equal(api.callsTo('panes.close').length, 1, 'no later pane is taken for the shell');
    dispose();

    const api2 = makeSwarmApi({ allowClose: true });
    const dispose2 = registerAll(api2);
    await dispose2.ready;
    dispose2.store.createdHiddenAt = Date.now() - 60000;
    await api2.upsert('old-pane', { workspaceID: 'ws-created-1', status: 'idle' });
    assert.equal(api2.callsTo('panes.close').length, 0, 'a pane first seen long after creation is not the shell');
    dispose2();
});

test('a shell pane close that keeps failing is given up after three attempts, never a worker', async () => {
    const api = makeSwarmApi({ allowClose: true, createShellPane: true, closeFails: true });
    const dispose = registerAll(api);
    await dispose.ready;
    for (let n = 0; n < 5; n += 1) await api.upsert('w1', { status: 'running' });
    const closes = api.callsTo('panes.close').map(c => c.args[0]);
    assert.equal(closes.length, 3);
    assert.ok(closes.every(id => id === 'shell-ws-created-1'));
    assert.equal(dispose.store.hiddenShellPaneID, null);
    dispose();
});
