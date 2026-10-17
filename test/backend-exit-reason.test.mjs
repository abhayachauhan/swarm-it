// Agent hook events (api.agents.onEvent): a worker's last reply, its errors, and why it stopped without a result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSwarmApi, MANIFEST } from './backend-fake-api.mjs';
import { exitReason, lastMessageLine } from '../backend/exits.mjs';

const { registerAll } = await import('../backend/index.mjs');

const RESULT = '/wt/w1/result.md';

/** A swarm whose manifest dir is a real temp dir, so the exit file the backend writes can be read back. w1 is idle: its Claude has ended. */
function setup(extra = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'swarm-exits-'));
    const api = makeSwarmApi({ w1Status: 'idle', settings: { manifestDir: dir }, files: { [`${dir}/ws1.json`]: JSON.stringify(MANIFEST) }, ...extra });
    return { api, dir, exitFile: paneID => join(dir, 'exits', `${paneID}.json`) };
}
const worker = async (api, paneID) => (await api.command('get-state', { workspaceID: 'ws1' })).snapshot.workers.find(w => w.paneID === paneID);
const ev = (type, paneID, extra = {}) => ({ type, paneID, workspaceID: 'ws1', agent: 'claude', status: 'idle', ...extra });

test('a stop event sets the worker last line to the last line of Claude reply, and the screen read no longer overrides it', async () => {
    const { api } = setup();
    const dispose = registerAll(api);
    await dispose.ready;
    assert.equal((await worker(api, 'w1')).lastLine, 'working...', 'before the event the screen is read');
    await api.agentEvent(ev('stop', 'w1', { lastAssistantMessage: 'Fixed the lag.\n\nAll tests pass.\n' }));
    assert.equal((await worker(api, 'w1')).lastLine, 'All tests pass.');
    api.captureStore.w1 = 'a different screen';
    await api.upsert('w1', { status: 'waitingForInput' });
    assert.equal((await worker(api, 'w1')).lastLine, 'All tests pass.', 'a pane refresh keeps the event line');
    await api.agentEvent(ev('start', 'w1'));
    await api.upsert('w1', { status: 'running' });
    assert.equal((await worker(api, 'w1')).lastLine, 'a different screen', 'a new turn goes back to the screen');
    dispose();
});

test('a stop event with no message changes nothing, and a long last line is capped at 200 characters', async () => {
    const { api } = setup();
    const dispose = registerAll(api);
    await dispose.ready;
    await api.agentEvent(ev('stop', 'w1'));
    assert.equal((await worker(api, 'w1')).lastLine, 'working...');
    await api.agentEvent(ev('stop', 'w1', { lastAssistantMessage: 'x'.repeat(500) }));
    assert.equal((await worker(api, 'w1')).lastLine, `${'x'.repeat(199)}…`);
    dispose();
});

test('an error event shows its message as the last line and becomes the reason when Claude then ends without a result', async () => {
    const { api, exitFile } = setup();
    const dispose = registerAll(api);
    await dispose.ready;
    await api.agentEvent(ev('error', 'w1', { message: 'API Error: connection reset' }));
    const w = await worker(api, 'w1');
    assert.equal(w.lastLine, 'API Error: connection reset');
    assert.equal(w.stopped, undefined, 'an error alone is not a stop');
    await api.agentEvent(ev('session-end', 'w1'));
    assert.deepEqual((await worker(api, 'w1')).stopped, { reason: 'stopped with an error: API Error: connection reset' });
    assert.equal(JSON.parse(readFileSync(exitFile('w1'), 'utf8')).reason, 'stopped with an error: API Error: connection reset');
    dispose();
});

test('a usage or rate limit is named in plain words, from the error message or from the final reply', async () => {
    assert.equal(exitReason('Claude AI usage limit reached|1760000000', ''), 'usage limit reached');
    assert.equal(exitReason(undefined, "You've hit your limit · resets 3pm (Australia/Sydney)"), 'usage limit reached');
    assert.equal(exitReason('API Error: 429 rate limit exceeded', ''), 'rate limit reached');
    assert.equal(exitReason('boom', 'fine'), 'stopped with an error: boom');
    assert.equal(exitReason(undefined, 'Done.'), 'Claude exited without writing a result');
    assert.equal(lastMessageLine(undefined), '');

    const { api } = setup();
    const dispose = registerAll(api);
    await dispose.ready;
    await api.agentEvent(ev('stop', 'w1', { lastAssistantMessage: "You've hit your limit · resets 3pm" }));
    await api.agentEvent(ev('session-end', 'w1'));
    assert.deepEqual((await worker(api, 'w1')).stopped, { reason: 'usage limit reached' });
    dispose();
});

test('session-end with no result marks the worker stopped: waiting state, a reason, and an exit file for swarm-wait', async () => {
    const { api, exitFile } = setup();
    const dispose = registerAll(api);
    await dispose.ready;
    await api.agentEvent(ev('session-end', 'w1'));
    const w = await worker(api, 'w1');
    assert.equal(w.state, 'waiting');
    assert.deepEqual(w.stopped, { reason: 'Claude exited without writing a result' });
    const file = JSON.parse(readFileSync(exitFile('w1'), 'utf8'));
    assert.deepEqual({ paneID: file.paneID, label: file.label, reason: file.reason }, { paneID: 'w1', label: 'repo-lag', reason: 'Claude exited without writing a result' });
    assert.match(file.at, /^\d{4}-\d\d-\d\dT/);
    assert.equal((await worker(api, 'w2')).stopped, undefined, 'the other worker is untouched');
    dispose();
});

test('session-end with a result is not a failure: the worker is done and no exit file is written', async () => {
    const { api, exitFile } = setup();
    api.fileStore[RESULT] = '## Goal\nfix lag\n## Done\n- fixed';
    const dispose = registerAll(api);
    await dispose.ready;
    await api.agentEvent(ev('session-end', 'w1'));
    const w = await worker(api, 'w1');
    assert.equal(w.stopped, undefined);
    assert.equal(w.state, 'done');
    assert.equal(existsSync(exitFile('w1')), false);
    dispose();
});

test('a worker with no result path is never marked stopped (no result can be expected)', async () => {
    const { api, exitFile } = setup();
    const dispose = registerAll(api);
    await dispose.ready;
    await api.agentEvent(ev('session-end', 'w2'));
    assert.equal((await worker(api, 'w2')).stopped, undefined);
    assert.equal(existsSync(exitFile('w2')), false);
    dispose();
});

test('events for panes that are not swarm workers are ignored: no state, no file, no publish', async () => {
    const { api, dir } = setup();
    const dispose = registerAll(api);
    await dispose.ready;
    const before = api.emitted.length;
    for (const paneID of ['stranger', 'orch', 'unknown-pane']) {
        await api.agentEvent(ev('session-end', paneID));
        await api.agentEvent(ev('stop', paneID, { lastAssistantMessage: 'hi' }));
        await api.agentEvent(ev('error', paneID, { message: 'boom' }));
    }
    await api.agentEvent({ type: 'stop' });
    await api.agentEvent(null);
    assert.equal(api.emitted.length, before, 'nothing was published');
    assert.equal(existsSync(join(dir, 'exits')), false);
    const snap = (await api.command('get-state', { workspaceID: 'ws1' })).snapshot;
    assert.deepEqual(snap.workers.filter(w => w.stopped), []);
    assert.equal(snap.workers.find(w => w.paneID === 'w1').lastLine, 'working...');
    dispose();
});

test('a restarted Claude (session-start or start) clears the stop and removes the exit file', async () => {
    for (const type of ['session-start', 'start']) {
        const { api, exitFile } = setup();
        const dispose = registerAll(api);
        await dispose.ready;
        await api.agentEvent(ev('session-end', 'w1'));
        assert.equal(existsSync(exitFile('w1')), true);
        await api.agentEvent(ev(type, 'w1'));
        assert.equal((await worker(api, 'w1')).stopped, undefined, type);
        assert.equal(existsSync(exitFile('w1')), false, type);
        dispose();
    }
});

test('a stopped worker survives a plugin reload', async () => {
    const storage = new Map();
    const first = setup({ storage });
    const dispose = registerAll(first.api);
    await dispose.ready;
    await first.api.agentEvent(ev('session-end', 'w1'));
    dispose();
    const second = makeSwarmApi({ w1Status: 'idle', storage, settings: { manifestDir: first.dir }, files: { [`${first.dir}/ws1.json`]: JSON.stringify(MANIFEST) } });
    const again = registerAll(second);
    await again.ready;
    assert.deepEqual((await worker(second, 'w1')).stopped, { reason: 'Claude exited without writing a result' });
    again();
});

test('an old Kelpi without agents.onEvent still works, and dispose unsubscribes on a new one', async () => {
    const old = setup({ noAgentEvents: true });
    assert.equal(old.api.agents, undefined);
    const dispose = registerAll(old.api);
    await dispose.ready;
    assert.equal((await worker(old.api, 'w1')).lastLine, 'working...');
    dispose();

    const current = setup();
    const again = registerAll(current.api);
    await again.ready;
    assert.equal(current.api.agentListeners.size, 1);
    again();
    assert.equal(current.api.agentListeners.size, 0);
});
