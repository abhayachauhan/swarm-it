import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeSwarmApi, PROMPT_TEXT } from './backend-fake-api.mjs';

// Set before the backend loads: it reads the scan interval, manifest reload interval and capture timeout once.
process.env.SWARM_PROMPT_SCAN_MS = '20';
process.env.SWARM_SWARMS_RELOAD_MS = '10';
process.env.SWARM_CAPTURE_TIMEOUT_MS = '50';
const { registerAll, SNAPSHOT_EVENT } = await import('../backend/index.mjs');
const lastSnapshot = api => api.emitted.filter(e => e.name === SNAPSHOT_EVENT).at(-1)?.data;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const requests = (api, paneID) => lastSnapshot(api).attention.filter(i => i.type === 'Request' && i.paneID === paneID);
const openRequests = (dispose, paneID) => dispose.store.attention.filter(i => i.type === 'Request' && i.paneID === paneID && !i.handledAt);

const SECOND = {
    version: 1,
    orchestrator: { paneID: 'orch2', label: 'coordinator' },
    workers: [
        { paneID: 'x1', label: 'worker-2', task: 'UI', resultPath: null, worktreePath: null, parent: null },
        { paneID: 'x2', label: 'misplaced', task: 'UI', resultPath: null, worktreePath: null, parent: null },
        { paneID: 'x3', label: 'hidden-worker', task: 'UI', resultPath: null, worktreePath: null, parent: null },
        { paneID: 'x4', label: 'finished', task: 'UI', resultPath: '/wt/x4/result.md', worktreePath: '/wt/x4', parent: null }
    ]
};
const STALE = {
    version: 1,
    orchestrator: { paneID: 'ghost', label: 'coordinator' },
    workers: [{ paneID: 'z1', label: 'orphan', task: '', resultPath: null, worktreePath: null, parent: null }]
};

/**
 * ws1 = the default swarm, ws2 = a second live swarm (ws5 is its `· workers` workspace), ws3 = no swarm,
 * ws4 = a stale manifest (orchestrator gone). x4 is a finished worker of ws2 (its result file exists).
 */
function makeApi(extra = {}) {
    return makeSwarmApi({
        otherWorkspaces: [{ id: 'ws2', name: 'Kelpi UI improvement' }, { id: 'ws3', name: 'Empty' }, { id: 'ws4', name: 'Old' }, { id: 'ws5', name: 'Kelpi UI improvement · workers' }],
        otherPanes: [
            { id: 'orch2', label: 'coordinator2', workspaceID: 'ws2', status: 'idle' },
            { id: 'x1', label: 'worker-2', workspaceID: 'ws2', status: 'running' },
            { id: 'x2', label: 'misplaced', workspaceID: 'ws3', status: 'running' },
            { id: 'x3', label: 'hidden-worker', workspaceID: 'ws5', status: 'running' },
            { id: 'x4', label: 'finished', workspaceID: 'ws2', status: 'idle' },
            { id: 'y1', label: 'not-listed', workspaceID: 'ws2', status: 'running' },
            { id: 'z1', label: 'orphan', workspaceID: 'ws4', status: 'running' },
            { id: 'plain', label: 'shell', workspaceID: 'ws3', status: 'idle' }
        ],
        files: { '/m/ws2.json': JSON.stringify(SECOND), '/m/ws4.json': JSON.stringify(STALE), '/wt/x4/result.md': '# Done' },
        captures: { orch2: '', x1: 'working', x2: PROMPT_TEXT, x3: 'working', x4: PROMPT_TEXT, y1: PROMPT_TEXT, z1: PROMPT_TEXT, plain: '$' },
        storage: extra.storage
    });
}

/** Follow `workspaceID`, show a prompt on x1 and wait for its card. */
async function cardOnX1(workspaceID = 'ws3', extra = {}) {
    const api = makeApi(extra);
    const dispose = registerAll(api);
    await dispose.ready;
    await api.command('get-state', { workspaceID });
    api.captureStore.x1 = PROMPT_TEXT;
    await sleep(80);
    return { api, dispose, card: requests(api, 'x1')[0] };
}

for (const followed of ['ws3', 'ws1']) {
    test(`another swarm's worker prompt raises a card tagged with its swarm while following ${followed}, and settles when it goes`, async () => {
        const api = makeApi();
        const dispose = registerAll(api);
        await dispose.ready;
        await api.command('get-state', { workspaceID: followed });
        api.captureStore.x1 = PROMPT_TEXT;
        await sleep(80);
        const cards = requests(api, 'x1');
        assert.equal(cards.length, 1);
        assert.equal(cards[0].swarmName, 'Kelpi UI improvement');
        assert.equal(cards[0].swarmWorkspaceID, 'ws2');
        assert.match(cards[0].text, /^worker-2 is asking: /);
        assert.equal(cards[0].paneLabel, 'worker-2');
        assert.equal(lastSnapshot(api).workspaceID, followed, 'the rail still follows the user');
        assert.equal(lastSnapshot(api).orchestrator?.paneID ?? null, followed === 'ws1' ? 'orch' : null, "the followed swarm's orchestrator, never orch2");
        assert.equal(lastSnapshot(api).workers.some(w => w.paneID === 'x1'), false, 'the worker list stays scoped');
        api.captureStore.x1 = 'moved on';
        await sleep(80);
        assert.equal(requests(api, 'x1').length, 0);
        dispose();
    });
}

test('approve works on a card from another swarm, with the live prompt checks', async () => {
    const api = makeApi();
    const dispose = registerAll(api);
    await dispose.ready;
    await api.command('get-state', { workspaceID: 'ws3' });
    api.captureStore.x1 = PROMPT_TEXT;
    await sleep(80);
    const [card] = requests(api, 'x1');
    const wrong = await api.command('approve', { itemID: card.id, promptHash: 'nope' });
    assert.equal(wrong.code, 'STALE');
    const result = await api.command('approve', { itemID: card.id, promptHash: card.promptHash });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(api.callsTo('terminal.sendKey').map(c => c.args), [['x1', 'enter']]);
    dispose();
});

test('a notification from another swarm raises a Request; its error notification is ignored', async () => {
    const api = makeApi();
    const dispose = registerAll(api);
    await dispose.ready;
    await api.command('get-state', { workspaceID: 'ws3' });
    await api.fire('daemon.notification', { data: { kind: 'agent-error', paneID: 'x1', body: 'boom' } });
    assert.equal(lastSnapshot(api).attention.some(i => i.paneID === 'x1'), false);
    api.captureStore.x1 = PROMPT_TEXT;
    await api.fire('daemon.notification', { data: { kind: 'agent-notification', paneID: 'x1', body: 'x' } });
    assert.equal(requests(api, 'x1')[0]?.swarmName, 'Kelpi UI improvement');
    dispose();
});

test('a stale manifest, an unlisted pane and a listed worker in the wrong workspace never raise a card and are refused', async () => {
    const api = makeApi();
    const dispose = registerAll(api);
    await dispose.ready;
    await api.command('get-state', { workspaceID: 'ws3' });
    await sleep(80);
    for (const paneID of ['z1', 'y1', 'x2']) {
        await api.fire('daemon.notification', { data: { kind: 'agent-notification', paneID, body: 'x' } });
        assert.equal(requests(api, paneID).length, 0, `${paneID} must not raise a card`);
    }
    assert.equal(api.callsTo('terminal.capture').some(c => ['z1', 'y1', 'x2'].includes(c.args[0])), false, 'never captured');
    const st = dispose.store;
    for (const paneID of ['z1', 'y1', 'x2', 'plain']) {
        st.attention.push({ id: `Request:${paneID}:t`, type: 'Request', paneID, text: '', command: 'rm -rf node_modules && npm ci', promptHash: 'h', createdAt: new Date().toISOString() });
        const result = await api.command('approve', { itemID: `Request:${paneID}:t`, promptHash: 'h' });
        assert.equal(result.code, 'NOT_WORKER', paneID);
    }
    assert.equal(api.callsTo('terminal.sendKey').length, 0);
    dispose();
});

test("another swarm's orchestrator is settle-only", async () => {
    const api = makeApi();
    api.captureStore.orch2 = PROMPT_TEXT;
    const dispose = registerAll(api);
    await dispose.ready;
    await api.command('get-state', { workspaceID: 'ws3' });
    await sleep(80);
    assert.equal(requests(api, 'orch2').length, 0, 'the scan never raises for an orchestrator');
    await api.fire('daemon.notification', { data: { kind: 'agent-notification', paneID: 'orch2', body: 'x' } });
    assert.equal(requests(api, 'orch2').length, 1);
    api.captureStore.orch2 = 'moved on';
    await sleep(80);
    assert.equal(requests(api, 'orch2').length, 0);
    dispose();
});

test('the rail names the swarm only on cards from another swarm', () => {
    vm.runInThisContext(readFileSync(new URL('../ui/sidebar/logic.js', import.meta.url), 'utf8'), { filename: 'logic.js' });
    const L = globalThis.SwarmLogic;
    const item = { paneID: 'x1', paneLabel: 'worker-2', text: 'worker-2 is asking: Do you want to proceed?', swarmName: 'Kelpi UI improvement', swarmWorkspaceID: 'ws2' };
    assert.equal(L.cardTitle(item, { workspaceID: 'ws3' }), 'worker-2 · Kelpi UI improvement');
    assert.equal(L.cardTitle(item, { workspaceID: 'ws2' }), 'worker-2');
    assert.equal(L.cardTitle({ paneID: 'p1', text: 'a' }, { workspaceID: 'ws3' }, 'repo-lag'), 'repo-lag');
});

test('deny works on a card from another swarm and sends only Escape', async () => {
    const { api, dispose, card } = await cardOnX1();
    const result = await api.command('deny', { itemID: card.id });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(api.callsTo('terminal.sendKey').map(c => c.args), [['x1', 'escape']]);
    assert.equal(openRequests(dispose, 'x1').length, 0);
    dispose();
});

test("another swarm's worker living in its `· workers` workspace raises a card that approve accepts", async () => {
    const api = makeApi();
    const dispose = registerAll(api);
    await dispose.ready;
    await api.command('get-state', { workspaceID: 'ws3' });
    api.captureStore.x3 = PROMPT_TEXT;
    await sleep(80);
    const [card] = requests(api, 'x3');
    assert.equal(card?.swarmName, 'Kelpi UI improvement');
    assert.equal(card.paneLabel, 'hidden-worker');
    const result = await api.command('approve', { itemID: card.id, promptHash: card.promptHash });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(api.callsTo('terminal.sendKey').map(c => c.args), [['x3', 'enter']]);
    dispose();
});

test("a finished worker of another swarm is never captured, and a prompting worker is captured once per scan", async () => {
    const api = makeApi();
    const dispose = registerAll(api);
    await dispose.ready;
    await api.command('get-state', { workspaceID: 'ws3' });
    api.captureStore.x1 = PROMPT_TEXT;
    await sleep(90);
    assert.equal(requests(api, 'x1').length, 1);
    dispose();
    await sleep(30);
    // x3 (no prompt) is captured exactly once per scan; x1 sits before it in the manifest, so equal counts mean the scan
    // that raised x1's card did not capture it a second time.
    const count = paneID => api.callsTo('terminal.capture').filter(c => c.args[0] === paneID).length;
    assert.equal(count('x1'), count('x3'));
    assert.equal(count('x4'), 0, 'x4 is done: never captured');
    assert.equal(requests(api, 'x4').length, 0);
    dispose();
});

test('the manifest directory is listed instead of reading one path per workspace', async () => {
    const api = makeApi();
    const dispose = registerAll(api);
    await dispose.ready;
    await api.command('get-state', { workspaceID: 'ws1' });
    const reads = path => api.callsTo('files.read').filter(c => c.args[0] === path).length;
    const before = { ws3: reads('/m/ws3.json'), lists: api.callsTo('files.list').length };
    await sleep(100);
    assert.ok(api.callsTo('files.list').length > before.lists, 'listed on reload');
    assert.equal(reads('/m/ws3.json'), before.ws3, 'a workspace with no manifest file is never read');
    assert.ok(reads('/m/ws2.json') > 0);
    dispose();
});

test('a hung capture times out, counts as failed, and scans never pile up behind it', async () => {
    const api = makeApi();
    const dispose = registerAll(api);
    await dispose.ready;
    await api.command('get-state', { workspaceID: 'ws3' });
    api.captureStore.x1 = PROMPT_TEXT;
    await sleep(80);
    const [card] = requests(api, 'x1');
    api.captureStore.x1 = () => new Promise(() => {});
    await sleep(300);
    const started = Date.now();
    const state = await api.command('get-state', { workspaceID: 'ws3' });
    assert.equal(state.ok, true);
    assert.ok(Date.now() - started < 200, `get-state waited ${Date.now() - started} ms behind queued scans`);
    assert.equal(requests(api, 'x1').length, 1, 'a failed capture keeps the card');
    const result = await api.command('approve', { itemID: card.id, promptHash: card.promptHash });
    assert.equal(result.code, 'STALE');
    assert.equal(api.callsTo('terminal.sendKey').length, 0);
    dispose();
});

test('a state change on a pane with an open Request publishes; closing the pane settles its card at once', async () => {
    const { api, dispose } = await cardOnX1();
    const emits = () => api.emitted.filter(e => e.name === SNAPSHOT_EVENT).length;
    const before = emits();
    await api.upsert('x1', { status: 'idle' });
    assert.ok(emits() > before, 'published for a non-followed pane');
    // x1 has been hidden into its swarm's workers workspace by now: the host reports the close where it lives.
    const where = api.paneList.find(p => p.id === 'x1').workspaceID;
    await api.fire('state.changed', { sequence: 9000, data: [{ kind: 'pane-removed', workspaceID: where, paneID: 'x1' }] });
    assert.equal(openRequests(dispose, 'x1').length, 0);
    assert.equal(requests(api, 'x1').length, 0);
    dispose();
});

for (const [what, vanish] of [
    ['its orchestrator closes', api => api.fire('state.changed', { sequence: 9000, data: [{ kind: 'pane-removed', workspaceID: 'ws2', paneID: 'orch2' }] })],
    ['its manifest is deleted', async api => { delete api.fileStore['/m/ws2.json']; }]
]) {
    test(`an open Request settles after ${what}`, async () => {
        const { api, dispose } = await cardOnX1();
        assert.equal(openRequests(dispose, 'x1').length, 1);
        await vanish(api);
        await sleep(120);
        assert.equal(openRequests(dispose, 'x1').length, 0);
        dispose();
    });
}

test('a card whose pane closed while the plugin was down settles on reload', async () => {
    const storage = new Map();
    const first = await cardOnX1('ws3', { storage });
    assert.equal(openRequests(first.dispose, 'x1').length, 1);
    first.dispose();
    const api = makeApi({ storage });
    api.paneList.splice(api.paneList.findIndex(p => p.id === 'x1'), 1);
    const dispose = registerAll(api);
    await dispose.ready;
    assert.equal(openRequests(dispose, 'x1').length, 0);
    dispose();
});

test('a Request no gate accepts is never offered Approve', async () => {
    const api = makeApi();
    const dispose = registerAll(api);
    await dispose.ready;
    dispose.store.attention.push({ id: 'Request:plain:t', type: 'Request', paneID: 'plain', text: '', command: 'ls', promptHash: 'h', createdAt: new Date().toISOString() });
    const { snapshot } = await api.command('get-state', {});
    assert.equal(snapshot.attention.find(i => i.id === 'Request:plain:t')?.approvable, false);
    await sleep(80);
    assert.equal(openRequests(dispose, 'plain').length, 0, 'settled after two scans');
    dispose();
});
