import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerAll, modules, RUN_VIEW } from '../backend/index.mjs';
import { makeFakeApi } from './backend-fake-api.mjs';

const CLAUDE = [
    '⏺ Run this yourself:',
    '',
    "  ! ssh root@192.168.7.253 'apt-get dist-upgrade -y -o",
    "    Dpkg::Options::=--force-confold'",
    ''
].join('\n');
const JOINED = "ssh root@192.168.7.253 'apt-get dist-upgrade -y -o Dpkg::Options::=--force-confold'";

async function setup({ captures = { c1: CLAUDE, s1: '$' }, clipboard = async () => true } = {}) {
    const api = makeFakeApi({
        workspaces: [{ id: 'ws1', name: 'Work' }],
        panes: [
            { id: 'c1', label: 'claude', workspaceID: 'ws1', agent: 'claude', isFocused: true, isActiveWorkspace: true, workingDirectory: '/repo' },
            { id: 's1', label: 'shell', workspaceID: 'ws1' }
        ],
        captures,
        allowClose: true
    });
    const copied = [];
    const dispose = registerAll(api, { ...modules, clipboard: async text => { copied.push(text); return clipboard(text); } });
    await dispose.ready;
    return { api, copied };
}

test('run-suggested opens the confirm view with the joined command and types nothing', async () => {
    const { api } = await setup();
    const result = await api.command('run-suggested', {}, { paneID: 'c1' });
    assert.equal(result.ok, true);
    assert.equal(result.command, JOINED);
    const [open] = api.callsTo('openView');
    assert.equal(open.args[0], RUN_VIEW);
    assert.equal(open.args[1].state.command, JOINED);
    assert.equal(open.args[1].state.sourcePaneID, 'c1');
    assert.deepEqual(open.args[1].state.targets.map(t => [t.paneID, t.agent]), [['c1', true], ['s1', false]]);
    assert.deepEqual(api.callsTo('terminal.capture')[0].args[1], { lines: 200, scrollback: true });
    assert.equal(api.callsTo('terminal.send').length, 0, 'nothing typed before the user confirms');
});

test('run-suggested uses the invocation pane, else the focused pane, and reports no command', async () => {
    const { api } = await setup({ captures: { c1: CLAUDE, s1: '⏺ All done.' } });
    assert.equal((await api.command('run-suggested', {}, {})).command, JOINED, 'focused pane c1');
    const none = await api.command('run-suggested', {}, { paneID: 's1' });
    assert.deepEqual([none.ok, none.code], [false, 'NO_COMMAND']);
    const missing = await api.command('run-suggested', { paneID: 'nope' });
    assert.equal(missing.code, 'NO_PANE');
});

test('confirm runs only with confirmed: true, in a new shell split next to the source pane', async () => {
    const { api } = await setup();
    await api.command('run-suggested', {}, { paneID: 'c1' });
    const unconfirmed = await api.command('run-suggested-confirm', { sourcePaneID: 'c1', text: JOINED, target: 'new' });
    assert.equal(unconfirmed.code, 'NOT_CONFIRMED');
    assert.equal(api.callsTo('panes.split').length, 0);
    const result = await api.command('run-suggested-confirm', { sourcePaneID: 'c1', text: JOINED, target: 'new', confirmed: true });
    assert.equal(result.ok, true);
    const [split] = api.callsTo('panes.split');
    assert.equal(split.args[0], 'c1');
    assert.equal(split.args[1].path, '/repo');
    assert.deepEqual(api.callsTo('terminal.send').map(c => c.args), [[result.paneID, JOINED]]);
    assert.deepEqual(api.callsTo('panes.close').map(c => c.args[0]), ['view-pane'], 'the confirm view closes');
});

test('confirm refuses control characters and an agent pane the user did not pick', async () => {
    const { api } = await setup();
    const bad = await api.command('run-suggested-confirm', { sourcePaneID: 'c1', text: 'echo \u001b]0;x\u0007', target: 'new', confirmed: true });
    assert.equal(bad.code, 'BAD_TEXT');
    const agent = await api.command('run-suggested-confirm', { sourcePaneID: 'c1', text: 'ls', target: 'c1', confirmed: true });
    assert.equal(agent.code, 'AGENT_PANE');
    assert.equal(api.callsTo('terminal.send').length, 0);
    const picked = await api.command('run-suggested-confirm', { sourcePaneID: 'c1', text: 'ls', target: 'c1', confirmed: true, allowAgent: true });
    assert.equal(picked.ok, true);
    const shell = await api.command('run-suggested-confirm', { sourcePaneID: 'c1', text: 'ls', target: 's1', confirmed: true });
    assert.equal(shell.paneID, 's1');
    // Typed into Claude, the command runs as its `!` shell command; a plain shell gets it as is.
    assert.deepEqual(api.callsTo('terminal.send').map(c => c.args), [['c1', '! ls'], ['s1', 'ls']]);
    const multi = await api.command('run-suggested-confirm', { sourcePaneID: 'c1', text: 'cd a\nls', target: 'c1', confirmed: true, allowAgent: true });
    assert.equal(multi.code, 'MULTI_LINE');
    await api.command('run-suggested-confirm', { sourcePaneID: 'c1', text: '! git status', target: 'c1', confirmed: true, allowAgent: true });
    assert.deepEqual(api.callsTo('terminal.send').at(-1).args, ['c1', '! git status'], 'an existing ! is not doubled');
});

test('confirm refuses a target pane outside the source pane\'s workspace', async () => {
    const api = makeFakeApi({
        workspaces: [{ id: 'ws1', name: 'Work' }, { id: 'ws2', name: 'Other' }],
        panes: [
            { id: 'c1', label: 'claude', workspaceID: 'ws1', agent: 'claude' },
            { id: 'far', label: 'shell', workspaceID: 'ws2' }
        ],
        captures: { c1: CLAUDE, far: '$' }
    });
    const dispose = registerAll(api, modules);
    await dispose.ready;
    const result = await api.command('run-suggested-confirm', { sourcePaneID: 'c1', text: 'ls', target: 'far', confirmed: true });
    assert.equal(result.code, 'NOT_TARGET');
    assert.equal(api.callsTo('terminal.send').length, 0);
});

test('a one-line suggestion defaults to Claude\'s own session; a busy Claude or many lines default to a new pane', async () => {
    const { defaultTarget } = modules.suggested;
    const claude = { id: 'c1', agent: 'claude', status: 'idle' };
    assert.equal(defaultTarget({ kind: 'bang', command: 'ls' }, claude), 'c1');
    assert.equal(defaultTarget({ kind: 'inline', command: 'aws sso login' }, claude), 'c1');
    assert.equal(defaultTarget({ kind: 'bare', command: 'curl -s x' }, claude), 'c1');
    assert.equal(defaultTarget({ kind: 'fence', command: 'ls' }, claude), 'c1');
    assert.equal(defaultTarget({ kind: 'fence', command: 'cd x\nls' }, claude), 'new');
    assert.equal(defaultTarget({ kind: 'bang', command: 'ls' }, { ...claude, status: 'running' }), 'new', 'mid-reply');
    assert.equal(defaultTarget({ kind: 'bang', command: 'ls' }, { ...claude, status: 'running', backgroundTasks: 0 }), 'new', 'mid-reply');
    // Kelpi keeps a pane "running" after the turn ends while background shells or agents run (backgroundTasks > 0).
    assert.equal(defaultTarget({ kind: 'bang', command: 'ls' }, { ...claude, status: 'running', backgroundTasks: 2 }), 'c1', 'turn over, background work left');
    assert.equal(defaultTarget({ kind: 'bang', command: 'a\nb' }, claude), 'new');
    assert.equal(defaultTarget({ kind: 'bang', command: 'ls' }, { id: 's1' }), 'new', 'not a Claude pane');
    const { api } = await setup();
    await api.command('run-suggested', {}, { paneID: 'c1' });
    assert.equal(api.callsTo('openView')[0].args[1].state.defaultTarget, 'c1');
});

test('copy-suggested puts the joined command on the clipboard, or opens the view when there is none', async () => {
    const { api, copied } = await setup();
    const result = await api.command('copy-suggested', {}, { paneID: 'c1' });
    assert.deepEqual([result.ok, result.copied, copied], [true, true, [JOINED]]);
    assert.equal(api.callsTo('openView').length, 0);
    const edited = await api.command('copy-suggested', { text: 'echo edited' });
    assert.equal(edited.copied, true);
    assert.equal(copied.at(-1), 'echo edited');
    assert.equal((await api.command('copy-suggested', { text: 'a\u0000b' })).code, 'BAD_TEXT');

    const off = await setup({ clipboard: async () => false });
    const fallback = await off.api.command('copy-suggested', {}, { paneID: 'c1' });
    assert.equal(fallback.ok, true);
    assert.equal(off.api.callsTo('openView')[0].args[1].state.mode, 'copy');
    assert.equal(off.api.callsTo('terminal.send').length, 0);
});

test('close-run-view closes only the view this plugin opened', async () => {
    const { api } = await setup();
    assert.deepEqual(await api.command('close-run-view'), { ok: true, closedViewPaneID: null });
    await api.command('run-suggested', {}, { paneID: 'c1' });
    assert.deepEqual(await api.command('close-run-view'), { ok: true, closedViewPaneID: 'view-pane' });
    assert.deepEqual(api.callsTo('panes.close').map(c => c.args[0]), ['view-pane']);
});
