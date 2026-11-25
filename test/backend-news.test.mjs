// Worker news: one JSON line per real event in <manifestDir>/news/<pane-id>.jsonl, for swarm workers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSwarmApi, MANIFEST, PROMPT_TEXT } from './backend-fake-api.mjs';

process.env.SWARM_PROMPT_SCAN_MS = '20';
process.env.SWARM_SWARMS_RELOAD_MS = '10';
process.env.SWARM_EXIT_CONFIRM_MS = '40';
const { registerAll } = await import('../backend/index.mjs');
const { writeNews, plainText, MAX_LINES, MAX_TEXT_CHARS } = await import('../backend/news.mjs');
const { createStore } = await import('../backend/store.mjs');

const RESULT = '/wt/w1/result.md';
const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const QUESTION = ['Which database should the tests use?', '', '❯ 1. SQLite', '  2. Postgres', '', 'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (condition, label = 'condition') => {
    for (let n = 0; n < 200; n += 1) { if (condition()) return; await sleep(10); }
    assert.fail(`timed out waiting for ${label}`);
};
/** Long enough for several scans, queued writes and the session-end confirmation. */
const settle = () => sleep(150);

/** A running plugin whose manifest directory is real, so the news files can be read back. */
async function start(extra = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'swarm-news-'));
    const manifest = extra.manifest ?? MANIFEST;
    const api = makeSwarmApi({ ...extra, settings: { manifestDir: dir, ...extra.settings }, files: { [`${dir}/ws1.json`]: JSON.stringify(manifest), ...extra.files } });
    const dispose = registerAll(api);
    await dispose.ready;
    const file = paneID => join(dir, 'news', `${paneID}.jsonl`);
    const lines = paneID => (existsSync(file(paneID)) ? readFileSync(file(paneID), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
    const kinds = paneID => lines(paneID).map(l => l.kind);
    const written = () => (existsSync(join(dir, 'news')) ? readdirSync(join(dir, 'news')).sort() : []);
    return { api, dir, dispose, file, lines, kinds, written, st: dispose.store };
}
const ev = (type, paneID, extra = {}) => ({ type, paneID, workspaceID: 'ws1', agent: 'claude', status: 'idle', ...extra });
const notify = (api, paneID, extra = {}) => api.fire('daemon.notification', { data: { paneID, kind: 'agent-notification', ...extra } });
const removePane = async (api, paneID) => {
    const index = api.paneList.findIndex(p => p.id === paneID);
    const [pane] = api.paneList.splice(index, 1);
    await api.fire('state.changed', { sequence: 5000 + index, data: [{ kind: 'pane-removed', workspaceID: pane.workspaceID, paneID }] });
};

test('a permission request writes one blocked line with the contract\'s fields, however often it is notified', async () => {
    const { api, dispose, file, lines } = await start({ captures: { w1: PROMPT_TEXT } });
    await notify(api, 'w1');
    await until(() => lines('w1').length > 0, 'a news line');
    await notify(api, 'w1');
    await notify(api, 'w1');
    await settle();
    const text = readFileSync(file('w1'), 'utf8');
    assert.equal(text.split('\n').length, 2, 'one line and its newline');
    const [line] = lines('w1');
    assert.deepEqual(Object.keys(line), ['at', 'pane', 'label', 'kind', 'text']);
    assert.deepEqual({ ...line, at: 'x' }, { at: 'x', pane: 'w1', label: 'repo-lag', kind: 'blocked', text: 'rm -rf node_modules && npm ci Reinstall dependencies' });
    assert.equal(new Date(line.at).toISOString(), line.at);
    assert.ok(Buffer.byteLength(text) < 4096);
    assert.equal(lstatSync(file('w1')).mode & 0o777, 0o600);
    dispose();
});

test('a request that auto-approve answers at once is not reported as blocked', async () => {
    const { api, dispose, lines } = await start();
    // Auto is on before the prompt appears, and the prompt leaves the screen once Enter answers it.
    const sendKey = api.terminal.sendKey;
    api.terminal.sendKey = async (...args) => { api.captureStore.w1 = 'working...'; return sendKey(...args); };
    assert.equal((await api.command('auto-approve', { on: true })).ok, true);
    api.captureStore.w1 = PROMPT_TEXT.replace('rm -rf node_modules && npm ci', 'npm test');
    await until(() => api.callsTo('terminal.sendKey').length > 0, 'the approval');
    await settle();
    assert.deepEqual(lines('w1').filter(l => l.kind === 'blocked'), []);
    dispose();
});

test('a question menu writes one blocked line with the question, and a new one only after it was gone', async () => {
    const { api, dispose, lines } = await start({ captures: { w1: QUESTION } });
    await until(() => lines('w1').length > 0, 'a news line');
    await settle();
    assert.deepEqual(lines('w1').map(l => [l.kind, l.text]), [['blocked', 'Which database should the tests use?']]);
    api.captureStore.w1 = 'working...';
    await settle();
    api.captureStore.w1 = QUESTION;
    await until(() => lines('w1').length === 2, 'the second question');
    dispose();
});

test('a stop event writes turn-done once, with the result path once the result exists', async () => {
    const { api, dispose, lines } = await start();
    await api.agentEvent(ev('stop', 'w1', { lastAssistantMessage: 'Need one more look.' }));
    await until(() => lines('w1').length === 1);
    api.fileStore[RESULT] = '## Goal\nx\n';
    await api.agentEvent(ev('stop', 'w1', { lastAssistantMessage: 'Done.' }));
    // The pane turning idle raises a Complete card for the same turn: it must not add a second line.
    await api.upsert('w1', { status: 'waitingForInput', agentSessionID: SESSION });
    await settle();
    assert.deepEqual(lines('w1').map(l => [l.kind, l.text]), [['turn-done', 'Need one more look.'], ['turn-done', RESULT]]);
    dispose();
});

test('a stop with background tasks still running is not a finished turn', async () => {
    const { api, dispose, lines } = await start();
    await api.agentEvent(ev('stop', 'w1', { backgroundTasks: 2, lastAssistantMessage: 'Waiting.' }));
    await settle();
    assert.deepEqual(lines('w1'), []);
    dispose();
});

test('an agent error writes one error line, not a second one for its Error card', async () => {
    const { api, dispose, lines, st } = await start();
    await api.agentEvent(ev('error', 'w1', { message: 'API Error: connection reset' }));
    await notify(api, 'w1', { kind: 'agent-error', body: 'API Error: connection reset' });
    await until(() => st.attention.some(i => i.type === 'Error'), 'the Error card');
    await settle();
    assert.deepEqual(lines('w1').map(l => [l.kind, l.text]), [['error', 'API Error: connection reset']]);
    dispose();
});

test('a session end writes exited once, with the result path or the reason', async () => {
    const { api, dispose, lines } = await start({ w1Status: 'idle' });
    await api.agentEvent(ev('session-end', 'w1'));
    await until(() => lines('w1').length === 1);
    await api.agentEvent(ev('session-end', 'w1'));
    await removePane(api, 'w1');
    await settle();
    assert.deepEqual(lines('w1').map(l => [l.kind, l.text]), [['exited', 'Claude exited without writing a result']]);

    const done = await start({ w1Status: 'idle', files: { [RESULT]: '## Goal\nx\n' } });
    await done.api.agentEvent(ev('session-end', 'w1'));
    await until(() => done.lines('w1').length === 1);
    assert.equal(done.lines('w1')[0].text, RESULT);
    done.dispose();
    dispose();
});

test('/clear (a session end followed by a new start) is not an exit', async () => {
    const { api, dispose, lines } = await start({ w1Status: 'idle' });
    await api.agentEvent(ev('session-end', 'w1'));
    await api.agentEvent(ev('session-start', 'w1', { sessionID: SESSION }));
    await api.agentEvent(ev('session-end', 'w1', { sessionID: SESSION }));
    await settle();
    assert.deepEqual(lines('w1'), []);
    dispose();
});

test('closing a worker pane writes exited once, and a move reported as a removal does not', async () => {
    const { api, dispose, lines } = await start();
    // Still listed by the host: the pane only moved.
    const where = api.paneList.find(p => p.id === 'w1').workspaceID;
    await api.fire('state.changed', { sequence: 900, data: [{ kind: 'pane-removed', workspaceID: where, paneID: 'w1' }] });
    await settle();
    assert.deepEqual(lines('w1'), []);
    await removePane(api, 'w2');
    await until(() => lines('w2').length > 0);
    await settle();
    assert.deepEqual(lines('w2').map(l => [l.kind, l.label, l.text]), [['exited', 'tests', 'pane closed without a result']]);
    dispose();
});

test('no news for the coordinator or a pane outside any swarm', async () => {
    const { api, dispose, written } = await start({ captures: { orch: PROMPT_TEXT, stranger: QUESTION, w1: 'working...' } });
    for (const paneID of ['orch', 'stranger']) {
        await notify(api, paneID);
        await api.agentEvent(ev('stop', paneID, { lastAssistantMessage: 'hi' }));
        await api.agentEvent(ev('error', paneID, { message: 'boom' }));
        await api.agentEvent(ev('session-end', paneID));
    }
    await api.command('auto-approve', { on: false });
    await settle();
    await removePane(api, 'stranger');
    await removePane(api, 'orch');
    await settle();
    assert.deepEqual(written(), []);
    dispose();
});

test('a coordinator that another manifest lists as a worker still gets no news', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swarm-news-'));
    const store = createStore({});
    store.settings.manifestDir = dir;
    const coordinator = { paneID: 'boss', label: 'sub' };
    store.swarms = [{ workspaceID: 'a', orchestrator: coordinator, workers: [] }, { workspaceID: 'b', orchestrator: { paneID: 'o', label: 'top' }, workers: [coordinator] }];
    assert.equal(await writeNews(store, 'boss', 'turn-done', 'x'), false);
    assert.equal(existsSync(join(dir, 'news')), false);
});

test('a worker of a swarm the rail does not follow gets news too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swarm-news-'));
    const other = { version: 1, orchestrator: { paneID: 'orch2', label: 'second' }, workers: [{ paneID: 'far', label: 'far-worker', task: 't', resultPath: null, worktreePath: null, parent: null }] };
    const api = makeSwarmApi({
        settings: { manifestDir: dir }, otherWorkspaces: [{ id: 'ws2', name: 'Second' }],
        otherPanes: [{ id: 'orch2', workspaceID: 'ws2' }, { id: 'far', workspaceID: 'ws2', status: 'running' }],
        files: { [`${dir}/ws1.json`]: JSON.stringify(MANIFEST), [`${dir}/ws2.json`]: JSON.stringify(other) }
    });
    const dispose = registerAll(api);
    await dispose.ready;
    await api.agentEvent(ev('stop', 'far', { workspaceID: 'ws2', lastAssistantMessage: 'All done.' }));
    const file = join(dir, 'news', 'far.jsonl');
    await until(() => existsSync(file));
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).kind, 'turn-done');
    dispose();
});

test('on a host without agent events the Complete and Error cards are the news', async () => {
    const { api, dispose, lines } = await start({ noAgentEvents: true });
    api.fileStore[RESULT] = '## Goal\nx\n';
    await api.upsert('w1', { status: 'waitingForInput' });
    await until(() => lines('w1').length > 0);
    await notify(api, 'w2', { kind: 'agent-error', body: 'boom' });
    await until(() => lines('w2').length > 0);
    await settle();
    assert.deepEqual(lines('w1').map(l => [l.kind, l.text]), [['turn-done', RESULT]]);
    assert.deepEqual(lines('w2').map(l => [l.kind, l.text]), [['error', 'boom']]);
    dispose();
});

test('on a host without agent events a closed pane is reported as exited only, not also as an error', async () => {
    const { api, dispose, lines, st } = await start({ noAgentEvents: true });
    await removePane(api, 'w2');
    await until(() => st.attention.some(i => i.type === 'Error'), 'the Error card');
    await settle();
    assert.deepEqual(lines('w2').map(l => l.kind), ['exited']);
    dispose();
});

function direct() {
    const dir = mkdtempSync(join(tmpdir(), 'swarm-news-'));
    const store = createStore({});
    store.settings.manifestDir = dir;
    store.manifestWorkers = [{ paneID: 'w1', label: 'repo-lag', resultPath: null }];
    const file = join(dir, 'news', 'w1.jsonl');
    const lines = () => readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    return { dir, store, file, lines };
}

test('text is one plain line of at most 200 characters', async () => {
    const { store, lines } = direct();
    await writeNews(store, 'w1', 'error', `\u001b[31mfirst\u001b[0m\r\nsecond third\u0000\tfourth ${'😀'.repeat(300)}`);
    const [{ text }] = lines();
    assert.ok(text.startsWith('first second third fourth 😀'), text);
    assert.ok(text.length <= MAX_TEXT_CHARS, String(text.length));
    assert.ok(!/[\p{Cc}\p{Zl}\p{Cs}]/u.test(text));
    assert.equal(plainText('x'.repeat(500)).length, MAX_TEXT_CHARS);
});

test('at is strictly increasing within a file, even when two events share a millisecond or the clock steps back', async () => {
    const { store, lines } = direct();
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    for (const at of [now, now, now - 5000, now + 10]) await writeNews(store, 'w1', 'turn-done', 'x', at);
    assert.deepEqual(lines().map(l => l.at.slice(-4)), ['000Z', '001Z', '002Z', '010Z']);
});

test('the file is capped at the newest lines, and no temporary file is left', async () => {
    const { dir, store, lines } = direct();
    for (let n = 0; n < MAX_LINES + 5; n += 1) await writeNews(store, 'w1', 'turn-done', `turn ${n}`, 1000 + n);
    assert.equal(lines().length, MAX_LINES);
    assert.equal(lines()[0].text, 'turn 5');
    assert.equal(lines().at(-1).text, `turn ${MAX_LINES + 4}`);
    assert.deepEqual(readdirSync(join(dir, 'news')), ['w1.jsonl']);
});

test('a line cut short by a crash does not swallow the next one', async () => {
    const { dir, store, file } = direct();
    mkdirSync(join(dir, 'news'));
    writeFileSync(file, '{"at":"2026-01-01T00:00:00.000Z","kind":"blo');
    await writeNews(store, 'w1', 'turn-done', 'x');
    assert.equal(JSON.parse(readFileSync(file, 'utf8').split('\n')[1]).kind, 'turn-done');
});

test('news is never written through a symlink at the file or at the news directory', async () => {
    const { dir, store, file, lines } = direct();
    const victim = join(dir, 'victim');
    writeFileSync(victim, 'keep');
    mkdirSync(join(dir, 'news'));
    symlinkSync(victim, file);
    assert.equal(await writeNews(store, 'w1', 'turn-done', 'x'), true);
    assert.equal(readFileSync(victim, 'utf8'), 'keep');
    assert.equal(lstatSync(file).isFile(), true);
    assert.equal(lines().length, 1);

    const linked = direct();
    const elsewhere = mkdtempSync(join(tmpdir(), 'swarm-elsewhere-'));
    symlinkSync(elsewhere, join(linked.dir, 'news'));
    assert.equal(await writeNews(linked.store, 'w1', 'turn-done', 'x'), false);
    assert.deepEqual(readdirSync(elsewhere), []);
});

test('a pane id that could leave the news directory is refused', async () => {
    const { dir, store } = direct();
    store.manifestWorkers = [{ paneID: '../escape', label: 'x' }];
    assert.equal(await writeNews(store, '../escape', 'turn-done', 'x'), false);
    assert.equal(existsSync(join(dir, 'escape.jsonl')), false);
});
