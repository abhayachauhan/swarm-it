import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeApi, makeSwarmApi, PROMPT_TEXT, MANIFEST, CODEX_FOLDER_TRUST } from './backend-fake-api.mjs';

// Set before the backend loads: it reads the scan interval once.
process.env.SWARM_PROMPT_SCAN_MS = '20';
const { registerAll, SNAPSHOT_EVENT } = await import('../backend/index.mjs');
const lastSnapshot = api => api.emitted.filter(e => e.name === SNAPSHOT_EVENT).at(-1)?.data;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const codexPrompt = ['Would you like to run the following command?', '', 'git status --short', '', '› 1. Yes, proceed', '  2. No, continue without running it'].join('\n');

test('a focused Codex pane with missing hooks exposes queued questions even during Auto, without answering them', async () => {
    const screen = 'Queued follow-up inputs\n? 1 question\n⇧← to answer\n\n› Ask Codex to do anything\nGPT-6.1-Sol low · ~/repos\n← for agents · ? for shortcuts';
    const api = makeFakeApi({ panes: [{ id: 'unknown', agent: null, type: 'shell', status: 'running', workspaceID: 'ws1', isFocused: true, isActiveWorkspace: true }], captures: { unknown: screen } });
    const dispose = registerAll(api);
    try {
        await dispose.ready;
        await api.command('auto-approve', { on: true, hours: 1 });
        await sleep(80);
        const requests = lastSnapshot(api).attention.filter(i => i.paneID === 'unknown');
        assert.equal(requests.length, 1);
        assert.equal(requests[0].approvable, false);
        assert.match(requests[0].text, /Shift\+Left Arrow/);
        assert.equal(api.callsTo('terminal.sendKey').length, 0);
        api.captureStore.unknown = 'Codex is working';
        await sleep(80);
        assert.equal(lastSnapshot(api).attention.some(i => i.paneID === 'unknown'), false);
    } finally { dispose(); }
});

test('an idle offscreen pane marked Action Required exposes queued Codex questions without hooks', async () => {
    const api = makeFakeApi({ panes: [{ id: 'unknown', type: 'shell', status: 'idle', workspaceID: 'ws1', title: '[ ! ] Action Required | task' }], captures: { unknown: 'Queued follow-up inputs\n? 1 question\n⇧← to answer\n› Ask Codex to do anything' } });
    const dispose = registerAll(api);
    try {
        await dispose.ready;
        await sleep(80);
        assert.equal(lastSnapshot(api).attention.filter(i => i.paneID === 'unknown').length, 1);
        assert.equal(api.callsTo('terminal.sendKey').length, 0);
    } finally { dispose(); }
});

test('a Codex coordinator question stays visible while Auto is off', async () => {
    const screen = 'Queued follow-up inputs\n? 1 question\n⇧← to answer\n› Ask Codex to do anything';
    const api = makeSwarmApi({ captures: { orch: screen } });
    const dispose = registerAll(api);
    try {
        await dispose.ready;
        await api.fire('daemon.notification', { data: { kind: 'agent-notification', paneID: 'orch', title: 'Codex' } });
        await sleep(80);
        assert.equal(lastSnapshot(api).attention.filter(i => i.paneID === 'orch').length, 1);
    } finally { dispose(); }
});

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

test('Codex screen scan finds a prompt when Kelpi has not identified the agent', async () => {
    const api = makeFakeApi({ panes: [{ id: 'unknown', agent: null, type: 'shell', status: 'waitingForInput', workspaceID: 'ws1' }], captures: { unknown: codexPrompt } });
    const dispose = registerAll(api);
    await dispose.ready;
    await sleep(80);
    const requests = lastSnapshot(api).attention.filter(i => i.type === 'Request' && i.paneID === 'unknown');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].agent, 'codex');
    assert.equal(requests[0].approvable, false);
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


test('an idle offscreen Codex worker without hooks exposes folder trust while Auto never answers it', async () => {
    const manifest = { ...MANIFEST, workers: MANIFEST.workers.map(w => w.paneID === 'w1' ? { ...w, agent: 'codex' } : w) };
    const api = makeSwarmApi({ files: { '/m/ws1.json': JSON.stringify(manifest) }, captures: { w1: CODEX_FOLDER_TRUST } });
    const dispose = registerAll(api);
    try {
        await dispose.ready;
        await api.upsert('w1', { status: 'idle', agent: null, agentSessionID: null, isFocused: false, isActiveWorkspace: false });
        await api.command('auto-approve', { on: true, hours: 1 });
        await sleep(100);
        const cards = lastSnapshot(api).attention.filter(i => i.paneID === 'w1');
        assert.equal(cards.length, 1);
        assert.equal(cards[0].approvable, false);
        assert.ok(cards[0].text.includes('folder trust'));
        assert.deepEqual(api.callsTo('terminal.sendKey'), []);
        assert.deepEqual(api.callsTo('terminal.send'), []);
        api.captureStore.w1 = 'Codex is working';
        await sleep(100);
        assert.equal(lastSnapshot(api).attention.filter(i => i.paneID === 'w1').length, 0);
    } finally { dispose(); }
});

test('a live Working footer clears a stale Codex waiting fallback but keeps genuine question cards', async () => {
    const manifest = { ...MANIFEST, workers: MANIFEST.workers.map(w => w.paneID === 'w1' ? { ...w, agent: 'codex' } : w) };
    const api = makeSwarmApi({ files: { '/m/ws1.json': JSON.stringify(manifest) }, captures: { w1: 'unknown input prompt' } });
    const dispose = registerAll(api);
    try {
        await dispose.ready;
        await api.upsert('w1', { agent: 'codex', status: 'waitingForInput' });
        await sleep(100);
        assert.equal(lastSnapshot(api).waitingPanes.some(p => p.paneID === 'w1'), true);
        api.captureStore.w1 = '• Working (1m 55s • esc to interrupt)\n› Ask Codex to do anything\nGPT-6.1-Sol high · ~/repos\n? for shortcuts';
        await sleep(100);
        assert.deepEqual(lastSnapshot(api).waitingPanes, []);
        assert.deepEqual(api.callsTo('terminal.sendKey'), []);
        api.captureStore.w1 = '• Working (2m • esc to interrupt)\nQueued follow-up inputs\n? 1 question\n⇧← to answer\n› Ask Codex to do anything';
        await sleep(100);
        assert.equal(lastSnapshot(api).attention.filter(p => p.paneID === 'w1').length, 1);
        assert.deepEqual(api.callsTo('terminal.sendKey'), []);
    } finally { dispose(); }
});
