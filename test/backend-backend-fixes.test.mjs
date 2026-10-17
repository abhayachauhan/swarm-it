// Request changes on a finished worker restarts Claude on its own conversation; auto-approve never answers dangerous commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSwarmApi } from './backend-fake-api.mjs';
import { NEVER_HITS, SAFE_BASIC } from './fixtures/never-commands.mjs';

process.env.SWARM_PROMPT_SCAN_MS = '20';
process.env.SWARM_SWARMS_RELOAD_MS = '10';
const { registerAll } = await import('../backend/index.mjs');
const { neverAutoApprove, NEVER_AUTO_APPROVE, NEVER_REASON } = await import('../backend/autoapprove.mjs');
const { shellQuote } = await import('../backend/actions.mjs');
const { availableActions } = await import('../ui/thread/logic.js');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const RESULT = '/wt/w1/result.md';
const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const prompt = cmd => ['╭──────────────────╮', ' Bash command', '', `   ${cmd}`, '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'].join('\n');

async function start(extra = {}) {
    const api = makeSwarmApi(extra);
    const dispose = registerAll(api);
    await dispose.ready;
    await api.command('get-state', { workspaceID: 'ws1' });
    return { api, dispose };
}
const stateOf = async (api, paneID) => (await api.command('get-state', { workspaceID: 'ws1' })).snapshot.workers.find(w => w.paneID === paneID)?.state;

/** w1 runs Claude (Kelpi reports its session), writes its result, and Claude exits (Kelpi clears the session, pane idle). */
async function finish(api) {
    await api.upsert('w1', { status: 'running', agentSessionID: SESSION });
    api.fileStore[RESULT] = '## Goal\nfirst\n';
    await api.upsert('w1', { status: 'idle', agentSessionID: null });
    await api.idle();
}

test('send-to-worker on a finished worker restarts Claude on its own session, quoted for zsh, and it reads running then done', async () => {
    const { api, dispose } = await start();
    await finish(api);
    assert.equal(await stateOf(api, 'w1'), 'done');
    const sent = await api.command('send-to-worker', { paneID: 'w1', text: "don't skip the tests." });
    assert.deepEqual(sent, { ok: true, paneID: 'w1', restarted: true });
    assert.deepEqual(api.callsTo('terminal.send').map(c => c.args), [['w1',
        `claude -p --resume ${SESSION} --permission-mode auto 'don'\\''t skip the tests. Write the updated result to ${RESULT}. Reply done.'`]]);
    assert.ok(!api.callsTo('terminal.send')[0].args[1].includes('--continue'));
    // The old result file is still there, but the worker is running again until a new one lands.
    assert.equal(await stateOf(api, 'w1'), 'running');
    await api.upsert('w1', { status: 'running', agentSessionID: SESSION });
    assert.equal(await stateOf(api, 'w1'), 'running', 'same result text while Claude runs: not done yet');
    api.fileStore[RESULT] = '## Goal\nsecond\n';
    await api.upsert('w1', { status: 'idle', agentSessionID: null });
    assert.equal(await stateOf(api, 'w1'), 'done');
    dispose();
});

test('a finished worker with no known session is refused and nothing is typed into its shell', async () => {
    const { api, dispose } = await start({ files: { [RESULT]: '## Goal\nx\n' } });
    await api.upsert('w1', { status: 'idle' });
    const sent = await api.command('send-to-worker', { paneID: 'w1', text: 'please fix' });
    assert.equal(sent.ok, false);
    assert.equal(sent.code, 'NO_SESSION');
    assert.equal(sent.error, 'this worker has finished and its conversation cannot be found');
    assert.equal(api.callsTo('terminal.send').length, 0);
    dispose();
});

test('the session id outlives a plugin reload, after Kelpi has already forgotten it', async () => {
    const storage = new Map();
    const first = await start({ storage });
    await finish(first.api);
    first.dispose();
    const { api, dispose } = await start({ storage, files: { [RESULT]: '## Goal\nfirst\n' } });
    api.paneList.find(p => p.id === 'w1').status = 'idle';
    await api.upsert('w1', { status: 'idle', agentSessionID: null });
    const sent = await api.command('send-to-worker', { paneID: 'w1', text: 'again' });
    assert.equal(sent.ok, true);
    assert.match(api.callsTo('terminal.send')[0].args[1], new RegExp(`^claude -p --resume ${SESSION} `));
    dispose();
});

test('while Claude is still alive at its input box the text is typed to it as before', async () => {
    const box = ['─'.repeat(40), '❯ ', '─'.repeat(40), '  ? for shortcuts'].join('\n');
    const { api, dispose } = await start({ captures: { w1: box } });
    await api.upsert('w1', { status: 'idle', agentSessionID: SESSION });
    assert.deepEqual(await api.command('send-to-worker', { paneID: 'w1', text: 'one more thing' }), { ok: true, paneID: 'w1' });
    assert.deepEqual(api.callsTo('terminal.send').map(c => c.args), [['w1', 'one more thing']]);
    dispose();
});

test('a restart still applies the text policy to the user text', async () => {
    const { api, dispose } = await start();
    await finish(api);
    assert.equal((await api.command('send-to-worker', { paneID: 'w1', text: 'bad\u001b[2J' })).code, 'BAD_TEXT');
    assert.equal(api.callsTo('terminal.send').length, 0);
    dispose();
});

test('shellQuote leaves nothing for zsh to expand', () => {
    assert.equal(shellQuote("a'b"), `'a'\\''b'`);
    assert.equal(shellQuote('$(rm -rf ~) `x` $HOME'), `'$(rm -rf ~) \`x\` $HOME'`);
});

test('the thread view offers "Send and restart" for a finished worker', () => {
    assert.equal(availableActions({ state: 'done' }).sendLabel, 'Send and restart');
    assert.equal(availableActions({ state: 'error' }).sendLabel, 'Send and restart');
    assert.equal(availableActions({ state: 'running' }).sendLabel, 'Send');
});

test('the never-auto-approve list matches every rule, in any segment and across a wrap', () => {
    assert.deepEqual(NEVER_AUTO_APPROVE.map(r => r.name).slice(0, 6), ['rm -r', 'git push', 'sudo', 'download piped into a shell', 'mkfs', 'dd of=']);
    assert.equal(Object.keys(NEVER_HITS).length, 27);
    for (const [command, rule] of Object.entries(NEVER_HITS)) assert.equal(neverAutoApprove(command), rule, command);
    for (const command of SAFE_BASIC) assert.equal(neverAutoApprove(command), null, command);
});

test('with Auto on, a command on the list is left as a card, logged as skipped once; manual Approve still works', async () => {
    const { api, dispose } = await start();
    await api.command('auto-approve', { on: true });
    api.captureStore.w1 = prompt('npm ci && sudo make install');
    await sleep(120);
    assert.equal(api.callsTo('terminal.sendKey').length, 0, 'no Enter');
    const card = dispose.store.attention.find(i => i.type === 'Request' && i.paneID === 'w1' && !i.handledAt);
    assert.ok(card, 'the card is left for the user');
    const { entries } = await api.command('auto-approve-log', {});
    assert.equal(entries.length, 1, 'logged once, not every scan');
    assert.deepEqual([entries[0].ok, entries[0].reason, entries[0].command], [false, NEVER_REASON, 'npm ci && sudo make install']);
    const auto = (await api.command('get-state', { workspaceID: 'ws1' })).snapshot.autoApprove;
    assert.deepEqual([auto.approved, auto.skipped, auto.failed], [0, 1, 0]);
    assert.deepEqual(await api.command('approve', { itemID: card.id, promptHash: card.promptHash }), { ok: true, itemID: card.id });
    assert.deepEqual(api.callsTo('terminal.sendKey').map(c => c.args), [['w1', 'enter']]);
    dispose();
});
