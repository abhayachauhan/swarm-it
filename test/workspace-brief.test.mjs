import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, stat, readdir, symlink, link, unlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceBriefs } from '../backend/workspace-brief.mjs';
import { makeFakeApi } from './backend-fake-api.mjs';

const SESSION = '11111111-2222-4333-8444-555555555555';
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const payload = (goal = 'Build a useful workspace brief') => ({ goal, now: 'Read the selected conversation', next: 'Verify the result', needsYou: '',
    steps: [{ text: 'Read context', state: 'done' }, { text: 'Verify result', state: 'active' }], pullRequests: [] });
const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function setup(options = {}) {
    let clock = 1_800_000_000_000;
    const calls = [];
    const api = makeFakeApi({ panes: [{ id: 'main', workspaceID: 'ws1', label: 'coordinator', agent: 'claude', ...options.pane },
        { id: 'foreign', workspaceID: 'ws2', label: 'coordinator', agent: 'codex' }], captures: { main: 'The selected goal', foreign: 'Another private conversation' }, storage: options.storage });
    const generate = options.generate ?? (async args => { calls.push(args); return payload(); });
    const controller = createWorkspaceBriefs({ api, generate, now: () => clock, home: options.home ?? '/no-such-workspace-brief-home' });
    return { api, calls, controller, advance: (ms = 120_000) => { clock += ms; } };
}
async function homeFor(t) {
    const home = await mkdtemp(join(tmpdir(), 'workspace-brief-test-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    return home;
}
async function transcript(home, agent, session, rows) {
    const directory = join(home, agent === 'claude' ? '.claude/projects/project' : '.codex/sessions/2026/10/29');
    await mkdir(directory, { recursive: true });
    const path = join(directory, agent === 'claude' ? `${session}.jsonl` : `rollout-2026-10-29-${session}.jsonl`);
    await writeFile(path, rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n');
    return path;
}
const claude = (role, text) => ({ type: role, message: { role, content: [{ type: 'text', text }] } });
const codex = (role, text) => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });

test('starts without waiting, saves only during the next command, and never executes an action', async () => {
    const work = deferred();
    const { api, controller } = setup({ generate: () => work.promise });
    const initial = await controller.get('ws1');
    assert.deepEqual(initial, { ok: true, workspaceID: 'ws1', brief: null, pending: true, error: null });
    const callsAtReturn = structuredClone(api.calls);
    work.resolve(payload());
    await settle();
    assert.deepEqual(api.calls, callsAtReturn, 'background completion must not call host APIs');
    assert.equal(api.storageMap.get('workspace-brief.v1.ws1').brief, null);
    const result = await controller.get('ws1', { refresh: false });
    assert.equal(result.pending, false);
    assert.equal(result.brief.goal, payload().goal);
    assert.equal(result.error, null);
    assert.equal(api.storageMap.get('workspace-brief.v1.ws1').brief.goal, payload().goal);
    assert.deepEqual(api.destructive, []);
    assert.deepEqual(api.calls.map(call => call.name).filter(name => name !== 'terminal.capture' && name !== 'storage.set'), []);
});

test('only one generation across workspaces and concurrent get calls, with no queued generation', async () => {
    const work = deferred();
    let count = 0;
    const { api, controller } = setup({ generate: () => { count++; return work.promise; } });
    const results = await Promise.all([controller.get('ws1'), controller.get('ws1', { force: true }), controller.get('ws2')]);
    assert.equal(count, 1);
    assert.deepEqual(results.map(result => result.pending), [true, true, false]);
    assert.deepEqual(api.callsTo('terminal.capture').map(call => call.args[0]), ['main']);
    work.resolve(payload());
    await settle();
    assert.equal(count, 1, 'the blocked workspace must not start automatically');
    await controller.get('ws2', { refresh: false });
    assert.equal(api.storageMap.get('workspace-brief.v1.ws1').brief.goal, payload().goal);
    assert.equal(api.storageMap.has('workspace-brief.v1.ws2'), false);
});

test('unchanged context stays cached, force respects the minimum interval, and changed context refreshes', async () => {
    const { api, calls, controller, advance } = setup();
    await controller.get('ws1');
    await settle();
    await controller.get('ws1');
    advance(119_999);
    await controller.get('ws1', { force: true });
    assert.equal(calls.length, 1);
    advance(1);
    assert.equal((await controller.get('ws1')).pending, false);
    assert.equal(calls.length, 1);
    await controller.get('ws1', { force: true });
    await settle();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].previous.goal, payload().goal);
    await controller.get('ws1', { refresh: false });
    advance();
    api.captureStore.main = 'A new user request';
    await controller.get('ws1');
    assert.equal(calls.length, 3);
    controller.dispose();
});

test('Claude and Codex use the exact session, first goal and recent messages, excluding tool instructions', async t => {
    for (const agent of ['claude', 'codex']) {
        const home = await homeFor(t);
        const message = agent === 'claude' ? claude : codex;
        await transcript(home, agent, OTHER, [message('user', 'FOREIGN SECRET')]);
        await transcript(home, agent, SESSION, [
            message('user', '# AGENTS.md instructions\n<INSTRUCTIONS>skip this</INSTRUCTIONS>'),
            message('user', 'Build the requested workspace brief'),
            message('assistant', 'A'.repeat(5000)),
            agent === 'claude' ? { type: 'user', message: { content: [{ type: 'tool_result', content: 'TOOL SECRET' }] } }
                : { type: 'response_item', payload: { type: 'function_call_output', output: 'TOOL SECRET' } },
            'malformed JSON', message('assistant', 'Recent implementation progress')
        ]);
        const { api, calls, controller } = setup({ home, pane: { agent, agentSessionID: SESSION } });
        await controller.get('ws1');
        assert.equal(calls.length, 1);
        const context = JSON.parse(calls[0].context);
        assert.equal(context.source, `${agent} transcript`);
        assert.equal(context.firstGoal, 'Build the requested workspace brief');
        assert.match(context.recent, /Recent implementation progress/);
        assert.doesNotMatch(calls[0].context, /FOREIGN SECRET|TOOL SECRET|Another private conversation/);
        assert.deepEqual(api.callsTo('terminal.capture').map(call => call.args[0]), ['main']);
        controller.dispose();
    }
});

test('Codex event transcripts and missing exact sessions use their own context only', async t => {
    const home = await homeFor(t);
    await transcript(home, 'codex', SESSION, [
        { type: 'event_msg', payload: { type: 'user_message', message: 'Event goal' } },
        { type: 'event_msg', payload: { type: 'agent_message', message: 'Event progress' } }
    ]);
    const { calls, controller } = setup({ home, pane: { agent: 'codex', agentSessionID: SESSION } });
    await controller.get('ws1');
    assert.equal(JSON.parse(calls[0].context).firstGoal, 'Event goal');
    controller.dispose();
    const missing = setup({ home, pane: { agent: 'codex', agentSessionID: OTHER } });
    await missing.controller.get('ws1');
    assert.equal(JSON.parse(missing.calls[0].context).source, 'screen');
    assert.doesNotMatch(missing.calls[0].context, /Event goal/);
    missing.controller.dispose();
});

test('a Codex screen overrides stale Claude metadata without reading its transcript or typing status', async t => {
    const home = await homeFor(t);
    await transcript(home, 'claude', SESSION, [claude('user', 'STALE CLAUDE GOAL')]);
    await transcript(home, 'codex', SESSION, [codex('user', 'STALE CODEX GOAL')]);
    const { api, calls, controller } = setup({ home, pane: { agentSessionID: SESSION } });
    api.captureStore.main = 'Current Codex progress\n› \n? for shortcuts';
    await controller.get('ws1');
    const context = JSON.parse(calls[0].context);
    assert.equal(context.source, 'screen');
    assert.equal(context.agent, 'codex');
    assert.match(context.recent, /Current Codex progress/);
    assert.doesNotMatch(calls[0].context, /STALE CLAUDE GOAL|STALE CODEX GOAL/);
    assert.deepEqual(api.callsTo('terminal.send'), []);
    assert.deepEqual(api.callsTo('terminal.sendKey'), []);
    controller.dispose();
});

test('chooses a coordinator then focused shell in the requested workspace only', async () => {
    const { api, calls, controller, advance } = setup();
    api.paneList.unshift({ id: 'focused', workspaceID: 'ws1', type: 'shell', agent: 'codex', isFocused: true });
    api.captureStore.focused = 'Focused goal';
    await controller.get('ws1');
    assert.equal(JSON.parse(calls[0].context).paneID, 'main');
    await settle();
    await controller.get('ws1', { refresh: false });
    advance();
    api.paneList.find(p => p.id === 'main').label = 'old';
    await controller.get('ws1');
    assert.equal(JSON.parse(calls[1].context).paneID, 'focused');
    controller.dispose();
});

test('large transcripts and escaping stay bounded while retaining the first goal and latest progress', async t => {
    const home = await homeFor(t);
    await transcript(home, 'claude', SESSION, [claude('user', 'Original goal'),
        ...Array.from({ length: 100 }, () => claude('assistant', 'Middle text '.repeat(1000))),
        claude('assistant', 'Latest progress ' + '\t\n"\\'.repeat(9000) + ' Most recent result')]);
    const { calls, controller } = setup({ home, pane: { agentSessionID: SESSION } });
    await controller.get('ws1');
    assert.ok(calls[0].context.length <= 24_000);
    const context = JSON.parse(calls[0].context);
    assert.equal(context.firstGoal, 'Original goal');
    assert.match(context.recent, /Most recent result/);
    controller.dispose();
});

test('busy screens retain the previous brief with no pending update', async () => {
    const { api, calls, controller, advance } = setup({ pane: { agent: 'codex' } });
    await controller.get('ws1'); await settle();
    const before = (await controller.get('ws1', { refresh: false })).brief;
    advance();
    api.captureStore.main = 'Working (esc to interrupt)';
    const busy = await controller.get('ws1', { force: true });
    assert.deepEqual(busy.brief, before);
    assert.equal(busy.pending, false);
    assert.equal(calls.length, 1);
});

test('model failure keeps the previous brief and waits 120 seconds after failure before retrying', async () => {
    let count = 0;
    const work = deferred();
    const { api, controller, advance } = setup({ generate: () => ++count === 1 ? payload() : work.promise });
    await controller.get('ws1'); await settle();
    const before = (await controller.get('ws1', { refresh: false })).brief;
    advance(); api.captureStore.main = 'Changed context';
    await controller.get('ws1');
    advance();
    work.reject(new Error('Model unavailable'));
    await settle();
    const failed = await controller.get('ws1');
    assert.equal(failed.error, 'Model unavailable');
    assert.equal(failed.pending, false);
    assert.deepEqual(failed.brief, before);
    advance(119_999);
    await controller.get('ws1', { force: true });
    assert.equal(count, 2);
    advance(1);
    assert.equal((await controller.get('ws1')).pending, true);
    assert.equal(count, 3);
    controller.dispose();
});

test('bounds fields, deduplicates steps and pull requests, and never trusts model pull request status', async () => {
    const value = payload('G'.repeat(1000));
    value.steps = [{ text: 'One', state: 'done' }, { text: 'one', state: 'todo' }, { text: 'bad', state: 'running' },
        ...Array.from({ length: 20 }, (_, n) => ({ text: `Step ${n}`, state: 'todo' }))];
    value.pullRequests = [
        { url: 'https://github.com/owner/repo/pull/12', title: 'Useful change title', status: 'merged' },
        { url: 'https://github.com/owner/repo/pull/12', title: 'Duplicate', status: 'open' },
        ...['https://github.com.evil/owner/repo/pull/1', 'javascript:alert(1)', 'https://github.com/owner/repo/issues/1',
            'https://github.com/owner/repo/pull/1?x=y', 'https://github.com/owner/repo/pull/0'].map(url => ({ url, title: 'Unsafe' }))
    ];
    const { controller } = setup({ generate: async () => value });
    await controller.get('ws1'); await settle();
    const { brief } = await controller.get('ws1', { refresh: false });
    assert.equal(brief.goal.length, 100);
    assert.equal(brief.steps.length, 12);
    assert.equal(brief.steps.filter(step => step.text.toLowerCase() === 'one').length, 1);
    assert.deepEqual(brief.pullRequests, [{ url: 'https://github.com/owner/repo/pull/12', title: 'Useful change title', status: 'unverified' }]);
});

test('malformed output preserves the previous brief and yields an exact error', async () => {
    let count = 0;
    const { controller, advance } = setup({ generate: async () => ++count === 1 ? payload() : { goal: 'bad' } });
    await controller.get('ws1'); await settle();
    const before = (await controller.get('ws1', { refresh: false })).brief;
    advance(); await controller.get('ws1', { force: true }); await settle();
    const result = await controller.get('ws1', { refresh: false });
    assert.equal(result.error, 'Invalid workspace brief payload');
    assert.deepEqual(result.brief, before);
});

test('pinned edits survive an in-flight generation, reload, and a Claude to Codex handoff', async () => {
    const work = deferred();
    const { api, controller, advance } = setup({ generate: () => work.promise });
    await controller.get('ws1');
    const edited = await controller.edit('ws1', { goal: 'My pinned goal', goalPinned: true });
    assert.equal(edited.brief.goalPinned, true);
    work.resolve(payload('Model replacement'));
    await settle();
    const completed = await controller.get('ws1', { refresh: false });
    assert.equal(completed.brief.goal, 'My pinned goal');
    assert.equal(completed.brief.now, payload().now);
    advance();
    const fresh = createWorkspaceBriefs({ api, now: () => 1_800_000_240_000, home: '/nonexistent', generate: async () => payload('Codex handoff goal') });
    api.paneList[0].agent = 'codex'; api.captureStore.main = 'Codex handoff progress\n› \n? for shortcuts';
    const loaded = await fresh.get('ws1');
    assert.equal(loaded.brief.goal, 'My pinned goal');
    await settle();
    assert.equal((await fresh.get('ws1', { refresh: false })).brief.goal, 'My pinned goal');
    await fresh.edit('ws1', { goalPinned: false });
    fresh.dispose(); controller.dispose();
    const reloaded = setup({ storage: api.storageMap });
    const restored = await reloaded.controller.get('ws1', { refresh: false });
    assert.equal(restored.brief.goalPinned, false);
    assert.equal(restored.brief.goal, 'My pinned goal');
});

test('invalid edits and workspace IDs leave stored briefs unchanged; returned data cannot mutate cache', async () => {
    const { api, controller } = setup();
    const edited = await controller.edit('ws1', { goal: 'A human goal' });
    const before = structuredClone([...api.storageMap]);
    assert.deepEqual(await controller.edit('ws1', { goal: 3 }), { ok: false, error: 'Invalid workspace brief edit' });
    assert.deepEqual(await controller.get('../ws2'), { ok: false, error: 'Invalid workspace ID' });
    assert.deepEqual(await controller.edit('__proto__', { goal: 'bad' }), { ok: false, error: 'Invalid workspace ID' });
    assert.deepEqual([...api.storageMap], before);
    edited.brief.goal = 'mutated response';
    assert.equal((await controller.get('ws1', { refresh: false })).brief.goal, 'A human goal');
});

test('malformed saved data cannot introduce an unsafe pull request or leak another workspace', async () => {
    const storage = new Map([
        ['workspace-brief.v1.ws1', { version: 1, brief: { goal: 99 } }],
        ['workspace-brief.v1.ws2', { version: 1, brief: { ...payload('Foreign saved goal'), goalPinned: true, updatedAt: '2026-10-29T00:00:00Z' } }]
    ]);
    const { controller } = setup({ storage });
    assert.equal((await controller.get('ws1', { refresh: false })).brief, null);
    assert.equal((await controller.get('ws2', { refresh: false })).brief.goal, 'Foreign saved goal');
});

test('storage write failure reports the exact error, keeps saved state, and retries during a command', async () => {
    const { api, controller } = setup();
    await controller.edit('ws1', { goal: 'Saved goal' });
    const before = structuredClone([...api.storageMap]);
    const set = api.storage.set;
    api.storage.set = async () => { throw new Error('disk full'); };
    const result = await controller.edit('ws1', { goal: 'Unsaved goal' });
    assert.equal(result.error, 'Could not save workspace brief: disk full');
    assert.equal(result.ok, false);
    assert.equal(result.brief.goal, 'Saved goal');
    assert.deepEqual([...api.storageMap], before);
    api.storage.set = set;
    assert.equal((await controller.get('ws1', { refresh: false })).brief.goal, 'Saved goal');
});

test('disposing aborts generation and prohibits later writes and calls', async () => {
    const work = deferred();
    let signal;
    const { api, controller } = setup({ generate: args => { signal = args.signal; return work.promise; } });
    await controller.get('ws1');
    controller.dispose();
    assert.equal(signal.aborted, true);
    const before = structuredClone(api.calls);
    work.resolve(payload()); await settle();
    assert.deepEqual(await controller.get('ws1'), { ok: false, error: 'Workspace briefs are disposed' });
    assert.deepEqual(await controller.edit('ws1', { goal: 'late' }), { ok: false, error: 'Workspace briefs are disposed' });
    assert.deepEqual(api.calls, before);
});

test('old Working text and ordinary interrupt instructions never block a brief', async () => {
    for (const agent of ['codex', 'claude']) {
        const { api, calls, controller, advance } = setup({ pane: { agent, status: 'running' } });
        await controller.get('ws1'); await settle();
        await controller.get('ws1', { refresh: false });
        advance();
        api.captureStore.main = [agent === 'codex' ? 'Working (esc to interrupt)' : '✶ Thinking… (esc to interrupt)', ...Array.from({ length: 15 }, (_, n) => `Completed output ${n}`),
            'The old log said esc to interrupt', ...(agent === 'codex' ? ['› ', '? for shortcuts'] : [])].join('\n');
        assert.equal((await controller.get('ws1')).pending, true);
        assert.equal(calls.length, 2);
        controller.dispose();
    }
});

test('live Claude activity needs a current spinner and running status; old output alone is insufficient', async () => {
    const { api, calls, controller, advance } = setup({ pane: { agent: 'claude', status: 'running' } });
    await controller.get('ws1'); await settle();
    await controller.get('ws1', { refresh: false });
    advance();
    api.captureStore.main = '✶ Thinking… (esc to interrupt)\n❯';
    const busy = await controller.get('ws1');
    assert.equal(busy.pending, false);
    assert.equal(calls.length, 1);
    assert.equal(busy.error, null);
    api.paneList[0].status = 'idle';
    assert.equal((await controller.get('ws1')).pending, true);
    assert.equal(calls.length, 2);
    controller.dispose();
});

test('shell-only and empty workspaces explain why no conversation brief is available', async () => {
    const { api, calls, controller } = setup({ pane: { agent: null, label: 'shell' } });
    api.captureStore.main = '$ pwd\n/Users/example/repo\n$';
    const result = await controller.get('ws1');
    assert.deepEqual(result, { ok: true, workspaceID: 'ws1', brief: null, pending: false,
        error: 'No Claude or Codex conversation is available in this workspace' });
    const empty = await controller.get('empty');
    assert.equal(empty.error, 'No Claude or Codex conversation is available in this workspace');
    assert.equal(calls.length, 0);
    assert.equal(api.storageMap.size, 0);
    assert.equal((await controller.get('ws1', { refresh: false })).error, 'No saved workspace brief is available yet');
});

test('cache fingerprints and failure backoff survive controller reload', async () => {
    const { api, calls, controller } = setup();
    await controller.get('ws1'); await settle();
    await controller.get('ws1', { refresh: false });
    controller.dispose();
    const reloaded = setup({ storage: api.storageMap });
    reloaded.advance();
    assert.equal((await reloaded.controller.get('ws1')).pending, false);
    assert.equal(reloaded.calls.length, 0);
    assert.equal(calls.length, 1);
    reloaded.controller.dispose();
    const failed = setup({ storage: api.storageMap, generate: async () => { throw new Error('Reload failure'); } });
    failed.advance();
    await failed.controller.get('ws1', { force: true }); await settle();
    await failed.controller.get('ws1', { refresh: false });
    failed.controller.dispose();
    const retry = setup({ storage: api.storageMap });
    retry.advance(239_999);
    const duringBackoff = await retry.controller.get('ws1', { force: true });
    assert.equal(duringBackoff.error, 'Reload failure');
    assert.equal(duringBackoff.pending, false);
    assert.equal(retry.calls.length, 0);
    retry.advance(1);
    assert.equal((await retry.controller.get('ws1')).pending, true);
    assert.equal(retry.calls.length, 1);
    retry.controller.dispose();
});

test('unpinning allows the next model update to replace the human goal', async () => {
    const { controller } = setup();
    await controller.edit('ws1', { goal: 'Human goal' });
    await controller.edit('ws1', { goalPinned: false });
    await controller.get('ws1'); await settle();
    const result = await controller.get('ws1', { refresh: false });
    assert.equal(result.brief.goal, payload().goal);
    assert.equal(result.brief.goalPinned, false);
});

test('storage read errors produce a result and cannot start model work', async () => {
    const { api, calls, controller } = setup();
    api.storage.get = async () => { throw new Error('Storage unavailable'); };
    const result = await controller.get('ws1');
    assert.equal(result.error, 'Storage unavailable');
    assert.equal(result.brief, null);
    assert.equal(result.pending, false);
    assert.equal(calls.length, 0);
    const edit = await controller.edit('ws1', { goal: 'Unsaved' });
    assert.equal(edit.ok, false);
    assert.equal(edit.error, 'Storage unavailable');
    assert.equal(api.storageMap.size, 0);
});

test('a request for another workspace reads only that workspace, never a foreign coordinator', async () => {
    const { api, calls, controller } = setup();
    await controller.get('ws2');
    const context = JSON.parse(calls[0].context);
    assert.equal(context.workspaceID, 'ws2');
    assert.equal(context.paneID, 'foreign');
    assert.equal(context.agent, 'codex');
    assert.equal(context.recent, 'Another private conversation');
    assert.doesNotMatch(calls[0].context, /The selected goal/);
    assert.deepEqual(api.callsTo('terminal.capture').map(call => call.args[0]), ['foreign']);
    controller.dispose();
});

test('colored live Working status keeps an existing brief without regeneration', async () => {
    const { api, calls, controller, advance } = setup({ pane: { agent: 'codex' } });
    await controller.get('ws1'); await settle();
    await controller.get('ws1', { refresh: false });
    advance();
    api.captureStore.main = '\u001b[32m• Working (4s • esc to interrupt)\u001b[0m\n› \n? for shortcuts';
    const result = await controller.get('ws1');
    assert.equal(result.pending, false);
    assert.equal(calls.length, 1);
});

test('a first brief is generated during ongoing work, then continued busy activity keeps that brief', async t => {
    for (const agent of ['claude', 'codex']) {
        const home = await homeFor(t);
        const message = agent === 'claude' ? claude : codex;
        await transcript(home, agent, SESSION, [message('user', 'Summarize the long-running workspace'), message('assistant', 'Implementation in progress')]);
        const { api, calls, controller, advance } = setup({ home, pane: { agent, status: 'running', agentSessionID: SESSION } });
        const status = agent === 'codex' ? '• Working (4s • esc to interrupt)\n› \n? for shortcuts' : '✶ Thinking… (esc to interrupt)\n❯';
        api.captureStore.main = status;
        const initial = await controller.get('ws1');
        assert.deepEqual(initial, { ok: true, workspaceID: 'ws1', brief: null, pending: true, error: null });
        assert.equal(calls.length, 1);
        assert.equal(JSON.parse(calls[0].context).firstGoal, 'Summarize the long-running workspace');
        await settle();
        const first = await controller.get('ws1', { refresh: false });
        assert.equal(first.brief.goal, payload().goal);
        for (let n = 0; n < 3; n++) {
            advance();
            api.captureStore.main = `Progress changed ${n}\n${status}`;
            const busy = await controller.get('ws1', { force: true });
            assert.equal(busy.pending, false);
            assert.deepEqual(busy.brief, first.brief);
        }
        assert.equal(calls.length, 1);
        assert.deepEqual(api.callsTo('terminal.send'), []);
        assert.deepEqual(api.callsTo('terminal.sendKey'), []);
        controller.dispose();
    }
});

const sidecarFile = home => join(home, '.kelpi-swarm', 'briefs', 'ws1.json');
const savedRecord = (goal = 'Saved file goal') => ({ version: 1, workspaceID: 'ws1', fingerprint: null, lastAttempt: null, error: null,
    brief: { ...payload(goal), goalPinned: true, updatedAt: '2026-10-29T00:00:00Z' } });
async function seedSidecar(home, value = savedRecord()) {
    const path = sidecarFile(home);
    await mkdir(join(home, '.kelpi-swarm', 'briefs'), { recursive: true, mode: 0o700 });
    await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
    return path;
}
function fillStorage(api) {
    api.storageMap.set('unrelated-data', { retained: 'X'.repeat(270_000) });
    const writes = [];
    api.storage.set = async (key, value) => {
        writes.push({ key, value: structuredClone(value) });
        throw new Error('plugin JSON exceeds 256 KiB');
    };
    return writes;
}

test('only the host size error falls back privately, allowing the first generation without losing plugin data', async t => {
    const home = await homeFor(t);
    await mkdir(join(home, '.kelpi-swarm', 'briefs'), { recursive: true });
    await chmod(join(home, '.kelpi-swarm', 'briefs'), 0o755);
    const { api, calls, controller } = setup({ home });
    const writes = fillStorage(api);
    const before = structuredClone([...api.storageMap]);
    const initial = await controller.get('ws1');
    assert.equal(initial.pending, true);
    assert.equal(initial.error, null);
    assert.equal(calls.length, 1);
    assert.equal(writes.length, 1);
    const path = sidecarFile(home);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).brief, null);
    assert.equal((await stat(join(home, '.kelpi-swarm', 'briefs'))).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await settle();
    const completed = await controller.get('ws1', { refresh: false });
    assert.equal(completed.brief.goal, payload().goal);
    assert.equal(completed.error, null);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).brief.goal, payload().goal);
    assert.equal(writes.length, 1, 'file-backed records must not retry API storage');
    assert.deepEqual([...api.storageMap], before);
    assert.deepEqual(await readdir(join(home, '.kelpi-swarm', 'briefs')), ['ws1.json']);
});

test('reload prefers the newer sidecar and keeps pinned edits file-backed despite stale API data', async t => {
    const home = await homeFor(t);
    await seedSidecar(home, savedRecord('Newer pinned goal'));
    const storage = new Map([['workspace-brief.v1.ws1', savedRecord('Stale API goal')], ['other', { preserve: true }]]);
    const before = structuredClone([...storage]);
    const { api, controller } = setup({ home, storage });
    let reads = 0, writes = 0;
    api.storage.get = async () => { reads++; throw new Error('API storage unavailable'); };
    api.storage.set = async () => { writes++; throw new Error('unrelated storage failure'); };
    assert.equal((await controller.get('ws1', { refresh: false })).brief.goal, 'Newer pinned goal');
    const edited = await controller.edit('ws1', { goal: 'Human pinned goal', goalPinned: true });
    assert.equal(edited.ok, true);
    await controller.get('ws1'); await settle();
    const generated = await controller.get('ws1', { refresh: false });
    assert.equal(generated.brief.goal, 'Human pinned goal');
    assert.equal(generated.brief.goalPinned, true);
    assert.equal(reads, 0);
    assert.equal(writes, 0);
    assert.deepEqual([...storage], before);
    controller.dispose();
    const reloaded = setup({ home, storage });
    const restored = await reloaded.controller.get('ws1', { refresh: false });
    assert.equal(restored.brief.goal, 'Human pinned goal');
    assert.equal(restored.brief.goalPinned, true);
});

test('model failures preserve the file-backed brief, pinned goal, and retry delay across reload', async t => {
    const home = await homeFor(t);
    await seedSidecar(home);
    const { controller, api } = setup({ home, generate: async () => { throw new Error('Summary unavailable'); } });
    const before = await controller.get('ws1', { refresh: false });
    await controller.get('ws1'); await settle();
    const failed = await controller.get('ws1', { refresh: false });
    assert.equal(failed.error, 'Summary unavailable');
    assert.deepEqual(failed.brief, before.brief);
    controller.dispose();
    const retry = setup({ home, storage: api.storageMap });
    const loaded = await retry.controller.get('ws1', { force: true });
    assert.equal(loaded.error, 'Summary unavailable');
    assert.equal(loaded.pending, false);
    assert.equal(loaded.brief.goal, before.brief.goal);
    assert.equal(loaded.brief.goalPinned, true);
    assert.equal(retry.calls.length, 0);
});

test('a failed sidecar edit preserves previous bytes and memory, and leaves no temporary files', async t => {
    const home = await homeFor(t);
    const path = await seedSidecar(home);
    const { controller, api } = setup({ home });
    const loaded = await controller.get('ws1', { refresh: false });
    const before = await readFile(path, 'utf8');
    const backup = join(home, 'preserved.json');
    await link(path, backup);
    const result = await controller.edit('ws1', { goal: 'Unsaved replacement' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Could not save workspace brief: Unsafe workspace brief sidecar');
    assert.deepEqual(result.brief, loaded.brief);
    assert.equal(await readFile(path, 'utf8'), before);
    assert.equal(await readFile(backup, 'utf8'), before);
    assert.equal(api.storageMap.size, 0);
    assert.deepEqual(await readdir(join(home, '.kelpi-swarm', 'briefs')), ['ws1.json']);
    await unlink(backup);
    const recovered = await controller.edit('ws1', { goal: 'Recovered edit' });
    assert.equal(recovered.ok, true);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).brief.goal, 'Recovered edit');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('other storage errors do not create a sidecar or launch a generation', async t => {
    for (const message of ['disk full', 'storage exceeds 256 KiB', 'plugin JSON exceeds 128 KiB']) {
        const home = await homeFor(t);
        const { api, calls, controller } = setup({ home });
        api.storage.set = async () => { throw new Error(message); };
        const result = await controller.get('ws1');
        assert.equal(result.error, `Could not save workspace brief: ${message}`);
        assert.equal(result.pending, false);
        assert.equal(calls.length, 0);
        assert.deepEqual(await readdir(home), []);
        assert.equal(api.storageMap.size, 0);
    }
});

test('malformed, oversized, wrong-workspace and linked sidecars cannot load or overwrite API data', async t => {
    const cases = [
        { name: 'invalid JSON', value: '{', error: 'Could not load workspace brief sidecar: Invalid saved workspace brief' },
        { name: 'wrong workspace', value: { ...savedRecord(), workspaceID: 'ws2' }, error: 'Could not load workspace brief sidecar: Invalid saved workspace brief' },
        { name: 'invalid fields', value: { ...savedRecord(), brief: { goal: 99 } }, error: 'Could not load workspace brief sidecar: Invalid saved workspace brief' },
        { name: 'oversized', value: 'X'.repeat(65_537), error: 'Could not load workspace brief sidecar: result file is larger than 65536 bytes' },
        { name: 'symbolic link', error: 'Could not load workspace brief sidecar: cannot open the result file: ELOOP' },
        { name: 'hard link', error: 'Could not load workspace brief sidecar: result file has more than one hard link' }
    ];
    for (const example of cases) {
        const home = await homeFor(t);
        const path = await seedSidecar(home, example.value ?? savedRecord());
        const original = await readFile(path, 'utf8');
        const victim = join(home, 'untouched.json');
        if (example.name === 'symbolic link') {
            await writeFile(victim, original);
            await unlink(path);
            await symlink(victim, path);
        } else if (example.name === 'hard link') await link(path, victim);
        const storage = new Map([['workspace-brief.v1.ws1', savedRecord('Old API value')]]);
        const before = structuredClone([...storage]);
        const { calls, controller } = setup({ home, storage });
        const result = await controller.get('ws1');
        assert.equal(result.error, example.error, example.name);
        assert.equal(result.brief, null);
        assert.equal(result.pending, false);
        assert.equal(calls.length, 0);
        assert.deepEqual([...storage], before);
        assert.equal(await readFile(path, 'utf8'), original);
    }
});

test('a linked sidecar directory is rejected without reading or writing its target', async t => {
    for (const name of ['.kelpi-swarm', 'briefs']) {
        const home = await homeFor(t);
        const external = await homeFor(t);
        const victim = join(external, 'ws1.json');
        await writeFile(victim, JSON.stringify(savedRecord('External secret')));
        if (name === 'briefs') await mkdir(join(home, '.kelpi-swarm'));
        await symlink(external, name === 'briefs' ? join(home, '.kelpi-swarm', 'briefs') : join(home, '.kelpi-swarm'));
        const before = await readFile(victim, 'utf8');
        const { api, calls, controller } = setup({ home });
        fillStorage(api);
        const storage = structuredClone([...api.storageMap]);
        const result = await controller.get('ws1');
        assert.equal(result.error, 'Unsafe workspace brief directory');
        assert.equal(result.brief, null);
        assert.equal(calls.length, 0);
        assert.equal(await readFile(victim, 'utf8'), before);
        assert.deepEqual([...api.storageMap], storage);
    }
});

test('failure to create the size-error fallback preserves plugin data and never starts the model', async t => {
    const home = await homeFor(t);
    const { api, calls, controller, advance } = setup({ home });
    api.storageMap.set('existing', { keep: 'all data' });
    const before = structuredClone([...api.storageMap]);
    let writes = 0;
    api.storage.set = async () => {
        writes++;
        await writeFile(join(home, '.kelpi-swarm'), 'Existing non-directory data');
        throw new Error('plugin JSON exceeds 256 KiB');
    };
    const result = await controller.get('ws1');
    assert.equal(result.error, 'Could not save workspace brief: Unsafe workspace brief directory');
    assert.equal(result.pending, false);
    assert.equal(result.brief, null);
    assert.equal(calls.length, 0);
    assert.deepEqual([...api.storageMap], before);
    assert.equal(await readFile(join(home, '.kelpi-swarm'), 'utf8'), 'Existing non-directory data');
    await unlink(join(home, '.kelpi-swarm'));
    advance();
    const recovered = await controller.get('ws1');
    assert.equal(recovered.pending, true);
    assert.equal(calls.length, 1);
    assert.equal(writes, 1, 'the file-backed record must recover without another API write');
    assert.deepEqual([...api.storageMap], before);
    controller.dispose();
});
