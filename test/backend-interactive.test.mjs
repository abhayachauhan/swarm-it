// Interactive workers: an agent that stays alive after its result. Auto-clean closes it only while idle, the rail
// reads it as waiting while it asks something, and Send reaches it only at its input box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSwarmApi, PROMPT_TEXT } from './backend-fake-api.mjs';

process.env.SWARM_PROMPT_SCAN_MS = '20';
process.env.SWARM_SWARMS_RELOAD_MS = '10';
const { registerAll } = await import('../backend/index.mjs');
const { autoClean, notIdle } = await import('../backend/workers.mjs');
const { sendToWorker } = await import('../backend/actions.mjs');
const { addItem } = await import('../backend/attention.mjs');
const { createStore, applyStateChange, deriveState } = await import('../backend/store.mjs');
const { createAttention } = await import('../backend/attention.mjs');
const { makeFakeApi } = await import('./backend-fake-api.mjs');
const { availableActions } = await import('../ui/thread/logic.js');

const MIN = 60000;
const RESULT = '/wt/w1/result.md';
const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const RULE = '─'.repeat(60);
const IDLE_BOX = ['⏺ Wrote the result.', '', RULE, '❯ ', RULE, '  ? for shortcuts'].join('\n');
const WORKING_BOX = ['⏺ Running tests', '✻ Thinking… (12s · esc to interrupt)', RULE, '❯ ', RULE, '  ? for shortcuts'].join('\n');
const BACKGROUND_BOX = ['⏺ Waiting for 2 background tasks', RULE, '❯ ', RULE, '  ? for shortcuts'].join('\n');
const QUESTION = ['Which database?', '', '❯ 1. SQLite', '  2. Postgres', '', 'Enter to select · Esc to cancel'].join('\n');
const DIALOG = ['Resume which conversation?', '  an older one', '  a newer one'].join('\n');
const SHELL = ['⏺ Wrote the result.', '', 'max@mac repo % '].join('\n');
const CODEX_IDLE = ['• Wrote the result.', '', '› Ask Codex to do anything', '', '  ? for shortcuts'].join('\n');
const W1 = { paneID: 'w1', label: 'repo-lag', resultPath: RESULT, worktreePath: '/wt/w1' };

/** One finished worker whose agent is still alive at its prompt. */
function setup({ screen = IDLE_BOX, status = 'idle', session = SESSION, agent = 'claude' } = {}) {
    const captures = screen === null ? {} : { w1: screen };
    const api = makeFakeApi({ allowClose: true, captures, gitStatus: { '/wt/w1': { kind: 'clean' } } });
    const store = createStore(api);
    store.att = createAttention(api, store);
    store.manifestWorkers = [{ ...W1, agent }];
    store.allowedWorkspace = () => true;
    applyStateChange(store, { kind: 'pane-upserted', workspaceID: 'wsW', paneID: 'w1', pane: { id: 'w1', status, agent, agentSessionID: session } });
    store.resultExists.set('w1', true);
    return { api, store };
}
const closes = api => api.callsTo('panes.close').map(c => c.args[0]);
async function clean({ api, store }) {
    await autoClean(api, store, store.manifestWorkers, 0);
    return autoClean(api, store, store.manifestWorkers, 10 * MIN);
}

// ---- auto-clean ----

for (const [name, options] of [
    ['a Claude idle at its input box', {}],
    ['a Claude whose finished turn Kelpi shows as waiting', { status: 'waitingForInput' }],
    ['a Codex idle at its composer', { agent: 'codex', status: 'waitingForInput', screen: CODEX_IDLE }],
    ['a stale session whose pane is back at a shell', { screen: SHELL, status: 'waitingForInput' }]
]) {
    test(`auto-clean closes ${name} after the delay, and not before`, async () => {
        const world = setup(options);
        await autoClean(world.api, world.store, world.store.manifestWorkers, 0);
        await autoClean(world.api, world.store, world.store.manifestWorkers, 10 * MIN - 1);
        assert.deepEqual(closes(world.api), []);
        assert.deepEqual((await autoClean(world.api, world.store, world.store.manifestWorkers, 10 * MIN)).cleaned, ['w1']);
        assert.deepEqual(closes(world.api), ['w1']);
    });
}

for (const [name, options, reason] of [
    ['working after an approval, while Kelpi still says waiting', { screen: WORKING_BOX, status: 'waitingForInput' }, 'mid-turn'],
    ['waiting for background tasks', { screen: BACKGROUND_BOX }, 'mid-turn'],
    ['showing a permission prompt', { screen: PROMPT_TEXT, status: 'waitingForInput' }, 'waiting on a person'],
    ['showing a question menu', { screen: QUESTION, status: 'waitingForInput' }, 'waiting on a person'],
    ['at some other dialog', { screen: DIALOG, status: 'waitingForInput' }, 'not at its input box'],
    ['impossible to read', { screen: null }, 'its screen cannot be read']
]) {
    test(`auto-clean keeps a done-looking worker that is ${name}, and starts the delay again`, async () => {
        const world = setup(options);
        const result = await clean(world);
        assert.deepEqual(result.busy, [{ paneID: 'w1', reason }]);
        assert.deepEqual(result.cleaned, []);
        assert.deepEqual(closes(world.api), []);
        assert.equal(world.store.archived.has('w1'), false);
        assert.equal(world.store.doneSince.get('w1'), 10 * MIN);
    });
}

test('auto-clean asks the host for the pane as it is now: a turn that started is not closed', async () => {
    const world = setup();
    world.api.paneList.push({ id: 'w1', status: 'running', agentSessionID: SESSION });
    assert.deepEqual((await clean(world)).busy, [{ paneID: 'w1', reason: 'mid-turn' }]);
    assert.deepEqual(closes(world.api), []);
});

test('a finished live worker with an open Request reads waiting, so it is neither timed nor closed', async () => {
    const world = setup({ status: 'waitingForInput' });
    await addItem(world.store.att, { type: 'Request', paneID: 'w1', text: 'asks' });
    assert.equal(deriveState(world.store, W1), 'waiting');
    assert.deepEqual((await clean(world)).cleaned, []);
    assert.equal(world.store.doneSince.has('w1'), false);
});

test('a card raised after the delay began still stops the close; a card left by an exited agent does not', async () => {
    // The state read says done (no card yet); the card is there by the time of the last look.
    const live = setup();
    await addItem(live.store.att, { type: 'Request', paneID: 'w1', text: 'asks' });
    assert.equal(await notIdle(live.api, live.store, 'w1'), 'waiting on a person');
    // A pane list may name the agent `agentKind`: a waiting Codex still counts as live.
    const codex = setup({ agent: 'codex', status: 'waitingForInput', session: null, screen: CODEX_IDLE });
    codex.api.panes.list = async () => [{ id: 'w1', status: 'waitingForInput', agentKind: 'codex' }];
    await addItem(codex.store.att, { type: 'Request', paneID: 'w1', text: 'asks' });
    assert.equal(await notIdle(codex.api, codex.store, 'w1'), 'waiting on a person');
    const exited = setup({ session: null, screen: SHELL });
    await addItem(exited.store.att, { type: 'Request', paneID: 'w1', text: 'asks' });
    assert.deepEqual((await clean(exited)).cleaned, ['w1']);
});

test('a finished live worker showing a prompt reads waiting; a shell left showing one stays done', () => {
    const live = setup({ status: 'waitingForInput' });
    assert.equal(deriveState(live.store, W1), 'done');
    live.store.displayPrompts.add('w1');
    assert.equal(deriveState(live.store, W1), 'waiting');
    const exited = setup({ session: null });
    exited.store.displayPrompts.add('w1');
    assert.equal(deriveState(exited.store, W1), 'done');
});

// ---- Send ----

const sends = api => api.callsTo('terminal.send').map(c => c.args);

test('send reaches a finished live worker as a plain follow-up, never as a shell command', async () => {
    for (const status of ['idle', 'waitingForInput']) {
        const { api, store } = setup({ status });
        store.accepted.add('w1');
        store.doneSince.set('w1', 0);
        await addItem(store.att, { type: 'Complete', paneID: 'w1', text: 'finished' });
        assert.deepEqual(await sendToWorker(api, store, 'w1', 'one more check'), { ok: true, paneID: 'w1' }, status);
        assert.deepEqual(sends(api), [['w1', 'one more check']]);
        assert.equal(store.doneSince.has('w1'), false, 'the auto-clean delay starts again');
        assert.equal(store.accepted.has('w1'), false);
        assert.equal(store.restarts.has('w1'), false);
        assert.deepEqual(store.attention.filter(i => !i.handledAt), []);
    }
});

test('send restarts the conversation only once the agent has exited and a shell is back', async () => {
    const { api, store } = setup({ screen: SHELL, session: null });
    store.sessions.set('w1', SESSION);
    const sent = await sendToWorker(api, store, 'w1', 'again');
    assert.deepEqual(sent, { ok: true, paneID: 'w1', restarted: true });
    assert.match(sends(api)[0][1], new RegExp(`^claude -p --resume ${SESSION} `));
});

for (const [name, options, code] of [
    ['mid-turn', { status: 'running' }, 'BUSY'],
    ['working while Kelpi says waiting', { screen: WORKING_BOX, status: 'waitingForInput' }, 'BUSY'],
    ['mid-turn on a screen with no input box', { screen: DIALOG, status: 'running' }, 'BUSY'],
    ['waiting on a permission prompt', { screen: PROMPT_TEXT, status: 'waitingForInput' }, 'PROMPT_OPEN'],
    ['waiting on a question menu', { screen: QUESTION, status: 'waitingForInput' }, 'PROMPT_OPEN'],
    ['alive at some other dialog', { screen: DIALOG, status: 'waitingForInput' }, 'NOT_AT_CLAUDE'],
    ['a Codex mid-turn', { agent: 'codex', status: 'running', screen: CODEX_IDLE }, 'BUSY'],
    ['a Codex waiting on a question menu', { agent: 'codex', status: 'waitingForInput', screen: QUESTION }, 'PROMPT_OPEN']
]) {
    test(`send is refused for a worker ${name}: nothing is typed`, async () => {
        const { api, store } = setup(options);
        store.sessions.set('w1', SESSION);
        const sent = await sendToWorker(api, store, 'w1', 'hello');
        assert.equal(sent.ok, false);
        assert.equal(sent.code, code);
        assert.deepEqual(sends(api), []);
        assert.equal(store.resultExists.get('w1'), true);
        assert.equal(store.restarts.has('w1'), false);
    });
}

test('a killed Claude that left its input box above a shell prompt gets the restart command, not the text', async () => {
    const { api, store } = setup({ screen: `${IDLE_BOX}\nmax@mac repo % ` });
    store.sessions.set('w1', SESSION);
    assert.equal((await sendToWorker(api, store, 'w1', 'hello')).restarted, true);
    assert.match(sends(api)[0][1], /^claude -p --resume /);
});

test('a status line ending in a percentage is not read as a shell prompt', async () => {
    const { api, store } = setup({ screen: `${IDLE_BOX}\n  Context left: 45%` });
    assert.deepEqual(await sendToWorker(api, store, 'w1', 'hello'), { ok: true, paneID: 'w1' });
});

test('the Send button offers a restart only when the finished worker\'s agent has exited', () => {
    assert.equal(availableActions({ state: 'done', agent: 'claude', live: true }).sendLabel, 'Send');
    assert.equal(availableActions({ state: 'done', agent: 'claude' }).sendLabel, 'Send and restart');
});

// ---- through the plugin ----

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async condition => { for (let n = 0; n < 200 && !condition(); n += 1) await sleep(10); assert.ok(condition()); };

test('through the plugin: a done worker still alive is scanned, reads waiting while it asks, and done again after', async () => {
    const api = makeSwarmApi({ w1Status: 'idle', files: { [RESULT]: '## Goal\nG\n' }, captures: { w1: IDLE_BOX } });
    Object.assign(api.paneList.find(p => p.id === 'w1'), { agentSessionID: SESSION });
    const dispose = registerAll(api);
    await dispose.ready;
    const st = dispose.store;
    const state = () => deriveState(st, st.manifestWorkers.find(w => w.paneID === 'w1'));
    assert.equal(state(), 'done');
    assert.equal((await api.command('get-state', { workspaceID: 'ws1' })).snapshot.workers.find(w => w.paneID === 'w1').live, true);
    api.captureStore.w1 = PROMPT_TEXT;
    await until(() => st.attention.some(i => i.type === 'Request' && i.paneID === 'w1' && !i.handledAt));
    assert.equal(state(), 'waiting');
    api.captureStore.w1 = IDLE_BOX;
    await until(() => state() === 'done');
    dispose();
});

test('through the plugin: a turn starting or ending restarts the auto-clean delay', async () => {
    const api = makeSwarmApi({ w1Status: 'idle', files: { [RESULT]: '## Goal\nG\n' } });
    const dispose = registerAll(api);
    await dispose.ready;
    for (const type of ['start', 'stop']) {
        dispose.store.doneSince.set('w1', 1);
        await api.agentEvent({ type, paneID: 'w1', workspaceID: 'ws1', agent: 'claude', status: 'idle' });
        assert.notEqual(dispose.store.doneSince.get('w1'), 1, type);
    }
    dispose();
});
