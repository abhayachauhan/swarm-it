import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSwarmApi, PROMPT_TEXT } from './backend-fake-api.mjs';

// Set before the backend loads: it reads the scan interval, manifest reload interval and capture timeout once.
process.env.SWARM_PROMPT_SCAN_MS = '20';
process.env.SWARM_SWARMS_RELOAD_MS = '10';
process.env.SWARM_CAPTURE_TIMEOUT_MS = '50';
const { registerAll, SNAPSHOT_EVENT } = await import('../backend/index.mjs');
const S = await import('../backend/store.mjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const lastSnapshot = api => api.emitted.filter(e => e.name === SNAPSHOT_EVENT).at(-1)?.data;

/** A permission prompt as a pane a few columns wide shows it: one word per line, which parsePrompt cannot read. */
const NARROW = ['Bash', 'command', 'rm', '-rf', 'x', 'Do', 'you', 'want', 'to', 'proceed?', '❯', '1.', 'Yes', '2.', 'No'].join('\n');

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

/** ws1 = the default swarm, ws2 = a second live swarm in Group g2 (ws5 its workers workspace), ws3 = no swarm. */
function makeApi(extra = {}) {
    return makeSwarmApi({
        otherWorkspaces: [{ id: 'ws2', name: 'Kelpi UI', groupID: 'g2' }, { id: 'ws3', name: 'Empty' }, { id: 'ws5', name: 'Kelpi UI · workers', groupID: 'g2' }],
        otherPanes: [
            { id: 'orch2', label: 'coordinator2', workspaceID: 'ws2', status: 'idle' },
            { id: 'x1', label: 'worker-2', workspaceID: 'ws2', status: 'running' },
            { id: 'x2', label: 'misplaced', workspaceID: 'ws3', status: 'running' },
            { id: 'x3', label: 'hidden-worker', workspaceID: 'ws5', status: 'running' },
            { id: 'x4', label: 'finished', workspaceID: 'ws2', status: 'idle' }
        ],
        files: { '/m/ws2.json': JSON.stringify(SECOND), '/wt/x4/result.md': '# Done' },
        captures: { orch2: '', x1: 'working', x2: 'working', x3: 'working', x4: '$' },
        groups: extra.groups ?? [{ id: 'g2', name: 'UI', color: 'purple' }],
        w1Status: extra.w1Status
    });
}

async function start(workspaceID = 'ws1', extra = {}) {
    const api = makeApi(extra);
    const dispose = registerAll(api);
    await dispose.ready;
    await api.command('get-state', { workspaceID });
    return { api, dispose };
}

test('a waiting worker whose prompt does not parse shows a waiting row, never a card, and auto-approve leaves it', async () => {
    const { api, dispose } = await start();
    await api.command('auto-approve', { on: true, hours: 1 });
    api.captureStore.w1 = NARROW;
    await api.upsert('w1', { status: 'waitingForInput' });
    await sleep(120);
    const snap = lastSnapshot(api);
    assert.deepEqual(snap.waitingPanes, [{ paneID: 'w1', label: 'repo-lag' }]);
    assert.equal(snap.attention.filter(i => i.paneID === 'w1').length, 0);
    assert.equal(api.callsTo('terminal.sendKey').length, 0);
    // The status changing clears it at once.
    await api.upsert('w1', { status: 'running' });
    assert.deepEqual(lastSnapshot(api).waitingPanes, []);
    dispose();
});

test('a waiting row gives way to the normal card once the prompt parses', async () => {
    const { api, dispose } = await start();
    api.captureStore.w1 = NARROW;
    await api.upsert('w1', { status: 'waitingForInput' });
    await sleep(120);
    assert.equal(lastSnapshot(api).waitingPanes.length, 1);
    api.captureStore.w1 = PROMPT_TEXT;
    await sleep(80);
    const snap = lastSnapshot(api);
    assert.deepEqual(snap.waitingPanes, []);
    assert.equal(snap.attention.filter(i => i.type === 'Request' && i.paneID === 'w1').length, 1);
    dispose();
});

test('a worker whose result file appears is done: its waiting row goes and does not come back', async () => {
    const { api, dispose } = await start();
    api.captureStore.w1 = NARROW;
    await api.upsert('w1', { status: 'waitingForInput' });
    await sleep(120);
    assert.equal(lastSnapshot(api).waitingPanes.length, 1);
    // The headless worker wrote its result; its shell keeps reporting waitingForInput.
    api.fileStore['/wt/w1/result.md'] = '# Goal';
    await sleep(120);
    assert.deepEqual(lastSnapshot(api).waitingPanes, []);
    assert.equal(dispose.store.unparsed.has('w1'), false);
    dispose();
});

test('a finished worker of another swarm reporting waitingForInput gets no waiting row', async () => {
    const { api, dispose } = await start();
    api.captureStore.x4 = NARROW;
    await api.upsert('x4', { status: 'waitingForInput' });
    api.captureStore.x1 = NARROW;
    await api.upsert('x1', { status: 'waitingForInput' });
    await sleep(150);
    assert.deepEqual(lastSnapshot(api).waitingPanes, [{ paneID: 'x1', label: 'worker-2', swarmName: 'Kelpi UI', swarmWorkspaceID: 'ws2' }]);
    dispose();
});

test('one scan with no prompt is not enough for a waiting row', () => {
    const st = S.createStore(null);
    st.unparsed.set('w1', { misses: 1, label: 'repo-lag', swarmName: null, swarmWorkspaceID: null });
    assert.deepEqual(S.buildSnapshot(st, Date.now()).waitingPanes, []);
    st.unparsed.get('w1').misses = 2;
    assert.deepEqual(S.buildSnapshot(st, Date.now()).waitingPanes, [{ paneID: 'w1', label: 'repo-lag' }]);
});

test('other live swarms are summarised with counts, Group colour and coordinator pane', async () => {
    const { api, dispose } = await start();
    await sleep(60);
    assert.deepEqual(lastSnapshot(api).otherSwarms, [
        { workspaceID: 'ws2', name: 'Kelpi UI', orchestratorPaneID: 'orch2', color: 'purple', running: 2, needYou: 0, done: 1 }
    ]);
    api.captureStore.x1 = PROMPT_TEXT;
    await sleep(80);
    const [summary] = lastSnapshot(api).otherSwarms;
    assert.deepEqual([summary.running, summary.needYou, summary.done], [1, 1, 1]);
    dispose();
});

test('the followed swarm is not in the summary; a swarm whose Group has no or an unknown colour gets null', async () => {
    const { api, dispose } = await start('ws3', { groups: [{ id: 'g2', name: 'UI', color: 'url(x)' }] });
    await sleep(60);
    const names = lastSnapshot(api).otherSwarms.map(s => [s.workspaceID, s.color]);
    assert.deepEqual(names.sort(), [['ws1', null], ['ws2', null]]);
    await api.command('get-state', { workspaceID: 'ws2' });
    await sleep(60);
    assert.deepEqual(lastSnapshot(api).otherSwarms.map(s => s.workspaceID), ['ws1']);
    dispose();
});

test('auto-approve takes fractional hours and an exact until time, capped at 7 days', async () => {
    const { api, dispose } = await start();
    const before = Date.now();
    let result = await api.command('auto-approve', { on: true, hours: 0.5 });
    assert.equal(result.ok, true);
    const end = Date.parse(result.autoApprove.until);
    assert.ok(end >= before + 1800000 && end <= Date.now() + 1800000);
    const until = new Date(Date.now() + 9 * 3600000 + 1234).toISOString();
    result = await api.command('auto-approve', { on: true, until });
    assert.equal(result.ok, true);
    assert.equal(result.autoApprove.until, until);
    for (const bad of [
        { on: true, until: new Date(Date.now() - 1000).toISOString() },
        { on: true, until: new Date(Date.now() + 8 * 24 * 3600000).toISOString() },
        { on: true, until: 'tomorrow' },
        { on: true, until: until, hours: 4 }
    ]) {
        const refused = await api.command('auto-approve', bad);
        assert.equal(refused.code, 'BAD_ARGS', JSON.stringify(bad));
    }
    dispose();
});
