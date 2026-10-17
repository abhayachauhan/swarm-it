// Review fixes A1-A4: send-to-worker never types into a shell, a wider never-auto-approve list, a restarted worker
// with an unchanged result still reads done, and a session id is recorded only while the worker runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSwarmApi } from './backend-fake-api.mjs';
import { NEVER_A2, SAFE_A2, NEVER_EXPANSION, SAFE_EXPANSION } from './fixtures/never-commands.mjs';

process.env.SWARM_PROMPT_SCAN_MS = '20';
process.env.SWARM_SWARMS_RELOAD_MS = '10';
const { registerAll } = await import('../backend/index.mjs');
const { neverAutoApprove } = await import('../backend/autoapprove.mjs');
const { showsClaudeInput } = await import('../backend/actions.mjs');

const RESULT = '/wt/w1/result.md';
const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const OTHER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const RULE = '─'.repeat(60);
const CLAUDE_BOX = ['⏺ Done. Tests pass.', '', RULE, '❯ ', RULE, '  ? for shortcuts'].join('\n');
const SHELL = ['⏺ Done. Tests pass.', '', 'max@mac kelpi % '].join('\n');
const PURE_SHELL = ['~/repos/kelpi main', '❯ '].join('\n');
const MENU = ['╭──────────────────╮', ' Bash command', '', '   npm test', '', ' Do you want to proceed?', RULE, ' ❯ 1. Yes', '   2. No', RULE].join('\n');

async function start(extra = {}) {
    const api = makeSwarmApi(extra);
    const dispose = registerAll(api);
    await dispose.ready;
    await api.command('get-state', { workspaceID: 'ws1' });
    return { api, dispose };
}
const stateOf = async (api, paneID) => (await api.command('get-state', { workspaceID: 'ws1' })).snapshot.workers.find(w => w.paneID === paneID)?.state;
const sends = api => api.callsTo('terminal.send').map(c => c.args);

// ---- A1 ----

test('showsClaudeInput: only Claude\'s ruled input box counts, not a shell prompt or a permission menu', () => {
    assert.equal(showsClaudeInput(CLAUDE_BOX), true);
    assert.equal(showsClaudeInput(`\u001b[2m${RULE}\u001b[0m\n❯ half typed\n${RULE}\n  status\n\n`), true);
    for (const screen of [SHELL, PURE_SHELL, MENU, '', `${RULE}\n❯ \n${RULE}\n1\n2\n3\n4\n5\nmax@mac % `]) assert.equal(showsClaudeInput(screen), false, screen);
});

test('A1: a worker whose result exists is restarted even while Kelpi still reports Claude waiting with a stale session', async () => {
    const { api, dispose } = await start({ captures: { w1: SHELL } });
    await api.upsert('w1', { status: 'running', agentSessionID: SESSION });
    api.fileStore[RESULT] = '## Goal\nfirst\n';
    // Claude died without its SessionEnd hook: Kelpi keeps waitingForInput and the session id.
    await api.upsert('w1', { status: 'waitingForInput', agentSessionID: SESSION });
    api.paneList.find(p => p.id === 'w1').status = 'waitingForInput';
    api.paneList.find(p => p.id === 'w1').agentSessionID = SESSION;
    const sent = await api.command('send-to-worker', { paneID: 'w1', text: 'rm the duplicate test file' });
    assert.deepEqual(sent, { ok: true, paneID: 'w1', restarted: true });
    assert.equal(sends(api).length, 1);
    assert.match(sends(api)[0][1], new RegExp(`^claude -p --resume ${SESSION} --permission-mode auto 'rm the duplicate test file\\. `));
    dispose();
});

test('A1: with no result, text is typed only when the pane shows Claude\'s input box; a shell prompt is refused', async () => {
    const { api, dispose } = await start({ captures: { w1: SHELL } });
    await api.upsert('w1', { status: 'waitingForInput', agentSessionID: SESSION });
    const refused = await api.command('send-to-worker', { paneID: 'w1', text: 'rm the duplicate test file' });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'NOT_AT_CLAUDE');
    assert.match(refused.error, /input box/);
    api.captureStore.w1 = PURE_SHELL;
    assert.equal((await api.command('send-to-worker', { paneID: 'w1', text: 'hi' })).code, 'NOT_AT_CLAUDE');
    api.captureStore.w1 = MENU;
    assert.equal((await api.command('send-to-worker', { paneID: 'w1', text: 'hi' })).code, 'PROMPT_OPEN');
    assert.equal(sends(api).length, 0, 'nothing typed into the shell');
    api.captureStore.w1 = CLAUDE_BOX;
    assert.deepEqual(await api.command('send-to-worker', { paneID: 'w1', text: 'one more thing' }), { ok: true, paneID: 'w1' });
    assert.deepEqual(sends(api), [['w1', 'one more thing']]);
    dispose();
});

test('A1: a finished worker whose pane shows a permission menu is not restarted: Enter would answer Yes', async () => {
    const { api, dispose } = await start({ captures: { w1: MENU } });
    await api.upsert('w1', { status: 'running', agentSessionID: SESSION });
    api.fileStore[RESULT] = '## Goal\nfirst\n';
    await api.upsert('w1', { status: 'idle', agentSessionID: null });
    await api.idle();
    assert.equal((await api.command('send-to-worker', { paneID: 'w1', text: 'again' })).code, 'PROMPT_OPEN');
    assert.equal(sends(api).length, 0);
    dispose();
});

// ---- A2 ----

test('A2: dangerous commands are never auto-approved', () => {
    assert.equal(NEVER_A2.length, 45);
    for (const cmd of NEVER_A2) assert.ok(neverAutoApprove(cmd), cmd);
});

test('A2: common safe commands stay auto-approvable', () => {
    assert.equal(SAFE_A2.length, 20);
    for (const cmd of SAFE_A2) assert.equal(neverAutoApprove(cmd), null, cmd);
});

test('shell expansion that builds a command word, and anything piped into a shell, are never auto-approved', () => {
    assert.deepEqual([NEVER_EXPANSION.length, SAFE_EXPANSION.length], [47, 6]);
    for (const cmd of NEVER_EXPANSION) assert.ok(neverAutoApprove(cmd), cmd);
    for (const cmd of SAFE_EXPANSION) assert.equal(neverAutoApprove(cmd), null, cmd);
});

// ---- A3 ----

test('A3: a restarted worker whose new result is byte-identical reads done once its Claude exits', async () => {
    const { api, dispose } = await start({ captures: { w1: SHELL } });
    await api.upsert('w1', { status: 'running', agentSessionID: SESSION });
    api.fileStore[RESULT] = '## Goal\nfirst\n';
    await api.upsert('w1', { status: 'idle', agentSessionID: null });
    await api.idle();
    assert.equal(await stateOf(api, 'w1'), 'done');
    assert.equal((await api.command('send-to-worker', { paneID: 'w1', text: 'check again' })).restarted, true);
    assert.equal(await stateOf(api, 'w1'), 'running');
    // A stray idle report before the new Claude ran does not end the restart.
    await api.upsert('w1', { status: 'idle', agentSessionID: null });
    assert.equal(await stateOf(api, 'w1'), 'running');
    await api.upsert('w1', { status: 'running', agentSessionID: SESSION });
    assert.equal(await stateOf(api, 'w1'), 'running');
    await api.upsert('w1', { status: 'idle', agentSessionID: null });
    await api.idle();
    assert.equal(await stateOf(api, 'w1'), 'done', 'same result text, Claude exited: done');
    dispose();
});

// ---- A4 ----

test('A4: a claude the user starts in a finished worker\'s pane is never the session that gets resumed', async () => {
    const { api, dispose } = await start({ captures: { w1: SHELL } });
    await api.upsert('w1', { status: 'running', agentSessionID: SESSION });
    api.fileStore[RESULT] = '## Goal\nfirst\n';
    await api.upsert('w1', { status: 'idle', agentSessionID: null });
    await api.idle();
    // The user runs their own claude in the pane, then quits it.
    await api.upsert('w1', { status: 'running', agentSessionID: OTHER });
    await api.upsert('w1', { status: 'idle', agentSessionID: null });
    await api.idle();
    api.paneList.find(p => p.id === 'w1').status = 'idle';
    const sent = await api.command('send-to-worker', { paneID: 'w1', text: 'again' });
    assert.equal(sent.restarted, true);
    assert.match(sends(api)[0][1], new RegExp(`--resume ${SESSION} `));
    assert.ok(!sends(api)[0][1].includes(OTHER));
    dispose();
});
