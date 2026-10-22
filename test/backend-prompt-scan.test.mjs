import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeApi, makeSwarmApi, PROMPT_TEXT } from './backend-fake-api.mjs';

// Set before the backend loads: it reads the scan interval once.
process.env.SWARM_PROMPT_SCAN_MS = '20';
const { registerAll, SNAPSHOT_EVENT } = await import('../backend/index.mjs');
const lastSnapshot = api => api.emitted.filter(e => e.name === SNAPSHOT_EVENT).at(-1)?.data;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const codexPrompt = ['Would you like to run the following command?', '', 'git status --short', '', '› 1. Yes, proceed', '  2. No, continue without running it'].join('\n');

test('Codex approval is detected by the screen scan and removed when its menu goes away', async () => {
    const api = makeSwarmApi();
    const dispose = registerAll(api);
    await dispose.ready;
    await api.upsert('w1', { agent: 'codex', status: 'waitingForInput', agentSessionID: '11111111-2222-4333-8444-555555555555' });
    api.captureStore.w1 = codexPrompt;
    await sleep(80);
    const requests = lastSnapshot(api).attention.filter(i => i.type === 'Request' && i.paneID === 'w1');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].approvable, false);
    assert.equal(api.callsTo('terminal.sendKey').length, 0);
    api.captureStore.w1 = 'Codex is working';
    await sleep(80);
    assert.equal(lastSnapshot(api).attention.some(i => i.type === 'Request' && i.paneID === 'w1'), false);
    dispose();
});

test('a Codex pane outside every swarm gets a request card while Auto is off', async () => {
    const api = makeFakeApi({ panes: [{ id: 'codex', agent: 'codex', type: 'shell', status: 'waitingForInput', workspaceID: 'ws1', agentSessionID: '11111111-2222-4333-8444-555555555555' }], captures: { codex: codexPrompt } });
    const dispose = registerAll(api);
    await dispose.ready;
    await sleep(80);
    const requests = lastSnapshot(api).attention.filter(i => i.type === 'Request' && i.paneID === 'codex');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].approvable, false);
    assert.equal(api.callsTo('terminal.sendKey').length, 0);
    dispose();
});

test('a prompt on a worker the user is watching (no notification, status still running) becomes a Request, and settles when it goes', async () => {
    const api = makeSwarmApi();
    const dispose = registerAll(api);
    await dispose.ready;
    await api.upsert('w1', { status: 'running' });
    api.captureStore.w1 = PROMPT_TEXT;
    await sleep(80);
    const requests = lastSnapshot(api).attention.filter(i => i.type === 'Request' && i.paneID === 'w1');
    assert.equal(requests.length, 1, 'one card, not one per scan');
    api.captureStore.w1 = 'working...';
    await sleep(80);
    assert.equal(lastSnapshot(api).attention.some(i => i.type === 'Request'), false);
    dispose();
});

test('an orchestrator card clears once its prompt is gone, and no card is raised for the orchestrator by the scan', async () => {
    const api = makeSwarmApi({ captures: { orch: PROMPT_TEXT } });
    const dispose = registerAll(api);
    await dispose.ready;
    await sleep(80);
    assert.equal(lastSnapshot(api).attention.some(i => i.paneID === 'orch'), false, 'scan never raises for the orchestrator');
    await api.fire('daemon.notification', { data: { kind: 'agent-notification', paneID: 'orch', body: 'x' } });
    assert.equal(lastSnapshot(api).attention.filter(i => i.paneID === 'orch').length, 1);
    await sleep(80);
    assert.equal(lastSnapshot(api).attention.filter(i => i.paneID === 'orch').length, 1, 'kept while the prompt shows');
    api.captureStore.orch = 'moved on';
    await sleep(80);
    assert.equal(lastSnapshot(api).attention.some(i => i.paneID === 'orch'), false);
    dispose();
});
