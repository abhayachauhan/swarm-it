import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerAll, modules } from '../backend/index.mjs';
import { restartClaude, claudeInputEmpty } from '../backend/restart.mjs';
import { createStore } from '../backend/store.mjs';
import { makeFakeApi } from './backend-fake-api.mjs';

const SID = '53097a1b-9915-4464-a820-f6cd7c855962';
const RULE = '─'.repeat(60);
const claudeScreen = (input = '') => ['⏺ Done.', '', RULE, `❯ ${input}`, RULE, '  [Opus 5.5] | ~/repos', '  ⏵⏵ auto mode on'].join('\n');
const SHELL = `Resume this session with:\nclaude --resume ${SID}\n$ `;
const PROMPT = [RULE, ' Bash command', '', '   ls', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel'].join('\n');

function setup({ screen = claudeScreen(), pane = {} } = {}) {
    const api = makeFakeApi({
        workspaces: [{ id: 'ws1', name: 'Work' }],
        panes: [{ id: 'c1', label: 'claude', workspaceID: 'ws1', agent: 'claude', agentSessionID: SID, status: 'idle', isFocused: true, isActiveWorkspace: true, ...pane }],
        captures: { c1: screen }
    });
    // /exit: Claude quits, Kelpi's SessionEnd hook clears the session, the shell comes back.
    const send = api.terminal.send;
    api.terminal.send = async (paneID, text, options) => {
        const r = await send(paneID, text);
        if (text === '/exit') { api.captureStore.c1 = SHELL; api.paneList[0].agentSessionID = null; }
        // A bare send is typed at the shell prompt; `echo` mimics a shell that keeps the paste end's `~`.
        if (options?.bare) api.captureStore.c1 += (api.mangle ?? (t => t))(text) + (api.echo ?? '');
        return r;
    };
    const sendKey = api.terminal.sendKey;
    api.terminal.sendKey = async (paneID, key) => {
        if (key === 'backspace') api.captureStore.c1 = api.captureStore.c1.slice(0, -1);
        return sendKey(paneID, key);
    };
    return api;
}
const sent = api => api.callsTo('terminal.send').map(c => c.args[1]);
const keys = api => api.callsTo('terminal.sendKey').map(c => c.args[1]);

test('a stray ~ left by a broken shell paste is erased before Enter', async () => {
    const api = setup({ screen: SHELL, pane: { agentSessionID: null } });
    api.echo = '~';
    const store = createStore(api);
    store.sessions.set('c1', SID);
    const { result } = await restartClaude(api, store, 'c1', noSleep);
    assert.equal(result.resumed, true);
    assert.deepEqual(keys(api), ['backspace', 'enter']);
});

test('the resume line is not run when the shell shows something else', async () => {
    const api = setup({ screen: SHELL, pane: { agentSessionID: null } });
    api.mangle = text => text.replace('--resume', '-resume');
    const store = createStore(api);
    store.sessions.set('c1', SID);
    const { result } = await restartClaude(api, store, 'c1', noSleep);
    assert.equal(result.code, 'TYPED_WRONG');
    assert.deepEqual(keys(api), []);
});
const noSleep = { sleep: async () => {} };

test('claudeInputEmpty: only an empty input box between the rules', () => {
    assert.equal(claudeInputEmpty(claudeScreen()), true);
    assert.equal(claudeInputEmpty(claudeScreen('Try "how do I log an error?"')), true, 'the dim hint of an empty box');
    assert.equal(claudeInputEmpty(claudeScreen('half a prompt')), false);
    assert.equal(claudeInputEmpty(SHELL), false);
    assert.equal(claudeInputEmpty(PROMPT), false);
});

test('an idle Claude is quit with /exit and resumed on the same session', async () => {
    const api = setup();
    const { result, finished } = await restartClaude(api, createStore(api), 'c1', noSleep);
    assert.deepEqual([result.ok, result.restarting, result.session], [true, true, SID]);
    assert.equal((await finished).resumed, true);
    assert.deepEqual(sent(api), ['/exit', `claude --resume ${SID}`]);
});

test('a pane already back at its shell is resumed from the plugin\'s saved session id', async () => {
    const api = setup({ screen: SHELL, pane: { agentSessionID: null } });
    const store = createStore(api);
    store.sessions.set('c1', SID);
    const { result } = await restartClaude(api, store, 'c1', noSleep);
    assert.equal(result.resumed, true);
    assert.deepEqual(sent(api), [`claude --resume ${SID}`]);
});

test('refuses, typing nothing, when restarting would lose work or answer a prompt', async () => {
    const cases = [
        [{ screen: PROMPT }, 'PROMPT_OPEN'],
        [{ pane: { status: 'running' } }, 'BUSY'],
        [{ screen: claudeScreen('half a prompt') }, 'INPUT_NOT_EMPTY'],
        [{ screen: `✻ Waiting for 1 background agent to finish\n${claudeScreen()}` }, 'BACKGROUND'],
        [{ pane: { agentSessionID: null } }, 'NO_SESSION'],
        [{ pane: { type: 'web' } }, 'NOT_SHELL']
    ];
    for (const [opts, code] of cases) {
        const api = setup(opts);
        const { result } = await restartClaude(api, createStore(api), 'c1', noSleep);
        assert.equal(result.code, code, JSON.stringify(opts));
        assert.deepEqual(sent(api), [], `${code}: nothing typed`);
    }
});

test('gives up without typing the resume line when Claude never exits', async () => {
    const api = setup();
    api.terminal.send = async (paneID, text) => { api.calls.push({ name: 'terminal.send', args: [paneID, text] }); return {}; };
    const { finished } = await restartClaude(api, createStore(api), 'c1', { ...noSleep, timeoutMs: 1000 });
    assert.equal((await finished).code, 'EXIT_TIMEOUT');
    assert.deepEqual(sent(api), ['/exit']);
});

test('restart-claude command uses the invocation pane and replies once the resume line is typed', async () => {
    const api = setup();
    const dispose = registerAll(api, { ...modules, restart: { restartClaude: (a, s, id) => restartClaude(a, s, id, noSleep) } });
    await dispose.ready;
    const result = await api.command('restart-claude', {}, { paneID: 'c1' });
    assert.equal(result.resumed, true);
    assert.deepEqual(sent(api), ['/exit', `claude --resume ${SID}`]);
    // Refusals throw, so the pane menu shows them as a toast.
    await assert.rejects(api.command('restart-claude', { paneID: 'nope' }), { code: 'NO_PANE' });
    api.captureStore.c1 = claudeScreen('half a prompt');
    api.paneList[0].agentSessionID = SID;
    await assert.rejects(api.command('restart-claude', {}, { paneID: 'c1' }), /input box has text/);
});
