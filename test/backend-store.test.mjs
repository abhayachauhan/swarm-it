import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, applyStateChange, buildSnapshot, persist, load, deriveState, refreshWorker, lastLineOf } from '../backend/store.mjs';
import { createAttention, addItem } from '../backend/attention.mjs';
import { makeFakeApi, MANIFEST } from './backend-fake-api.mjs';

function setup(extra = {}) {
    const api = makeFakeApi(extra);
    const store = createStore(api);
    createAttention(api, store);
    store.workspaceID = 'ws1';
    store.manifestWorkers = MANIFEST.workers;
    store.orchestrator = { paneID: 'orch', label: 'coordinator', source: 'manifest' };
    return { api, store };
}
const upsert = (store, paneID, status, extra = {}) =>
    applyStateChange(store, { kind: 'pane-upserted', workspaceID: 'ws1', paneID, pane: { id: paneID, status, label: paneID, ...extra } }, Date.parse('2026-01-01T00:00:00Z'));

test('applyStateChange reports new panes, status changes and removals', () => {
    const { store } = setup();
    assert.deepEqual(upsert(store, 'w1', 'running'), [{ kind: 'new', paneID: 'w1', to: 'running' }]);
    assert.deepEqual(upsert(store, 'w1', 'waitingForInput'), [{ kind: 'status', paneID: 'w1', from: 'running', to: 'waitingForInput' }]);
    assert.equal(upsert(store, 'w1', 'waitingForInput')[0].kind, 'updated');
    // a stale removal at the OLD workspace after a move is ignored
    upsert(store, 'w1', 'running', { });
    store.panes.get('w1').workspaceID = 'hidden';
    assert.deepEqual(applyStateChange(store, { kind: 'pane-removed', workspaceID: 'ws1', paneID: 'w1' }), []);
    assert.equal(applyStateChange(store, { kind: 'pane-removed', workspaceID: 'hidden', paneID: 'w1' })[0].kind, 'removed');
    assert.equal(applyStateChange(store, { kind: 'layout-changed' }).length, 0);
});

test('derived worker state: running, waiting, done, error (acceptance 2)', () => {
    const { store } = setup();
    const w1 = MANIFEST.workers[0];
    upsert(store, 'w1', 'running');
    assert.equal(deriveState(store, w1), 'running');
    upsert(store, 'w1', 'waitingForInput');
    assert.equal(deriveState(store, w1), 'waiting');
    store.resultExists.set('w1', true);
    assert.equal(deriveState(store, w1), 'done', 'result file wins over waitingForInput');
    upsert(store, 'w1', 'running');
    assert.equal(deriveState(store, w1), 'running', 'a running agent is running even with an old result');
    store.resultExists.set('w1', false);
    upsert(store, 'w1', 'idle');
    assert.equal(deriveState(store, w1), 'waiting', 'idle after running with no result');
    store.errored.add('w1');
    assert.equal(deriveState(store, w1), 'error');
    // pane closed
    applyStateChange(store, { kind: 'pane-removed', workspaceID: 'ws1', paneID: 'w1' });
    store.errored.clear();
    assert.equal(deriveState(store, w1), 'error', 'closed with no result');
    store.resultExists.set('w1', true);
    assert.equal(deriveState(store, w1), 'done', 'closed with result');
    // brand-new idle pane that has never run counts as starting
    upsert(store, 'w2', 'idle');
    assert.equal(deriveState(store, MANIFEST.workers[1]), 'running');
});

test('buildSnapshot: order, counts, elapsed time, last line, monotonic sequence', async () => {
    const { api, store } = setup({ captures: { w1: 'ok\n\n  ❯ implementing the fix  \n───────\n', w2: 'a' }, files: { '/wt/w1/result.md': '# Goal\nx' } });
    upsert(store, 'w1', 'running');
    upsert(store, 'w2', 'waitingForInput');
    await refreshWorker(store, 'w1');
    await refreshWorker(store, 'w2');
    const snap = buildSnapshot(store, Date.parse('2026-01-01T00:02:05Z'));
    assert.equal(snap.version, 1);
    assert.deepEqual(snap.workers.map(w => [w.paneID, w.state]), [['w2', 'waiting'], ['w1', 'running']]);
    assert.equal(snap.workers[1].elapsedSeconds, 125);
    assert.equal(snap.workers[1].lastLine, '❯ implementing the fix', 'last non-empty line, pure decoration lines skipped');
    assert.deepEqual(snap.counts, { waiting: 1, running: 1, finished: 0 });
    assert.ok(!snap.workers.some(w => w.paneID === 'orch'), 'orchestrator is not in workers');
    assert.equal(snap.workers[0].task, 'Write tests');
    assert.equal(snap.workers[1].resultPath, '/wt/w1/result.md');
    const again = buildSnapshot(store, Date.now());
    assert.ok(again.sequence > snap.sequence);
    void api;
});

test('archived workers stay in the snapshot but leave the counts', () => {
    const { store } = setup();
    upsert(store, 'w1', 'running');
    upsert(store, 'w2', 'running');
    store.archived.add('w2');
    const snap = buildSnapshot(store, Date.now());
    assert.equal(snap.workers.length, 2);
    assert.equal(snap.workers.find(w => w.paneID === 'w2').archived, true);
    assert.equal(snap.counts.running, 1);
});

test('snapshot splits attention into visible and snoozed', async () => {
    const { store } = setup();
    const att = store.att;
    const a = (await addItem(att, { type: 'Error', paneID: 'w1', text: 'boom', createdAt: '2026-01-01T00:00:00.000Z' })).item;
    const b = (await addItem(att, { type: 'Complete', paneID: 'w2', text: 'done', createdAt: '2026-01-01T00:00:01.000Z' })).item;
    b.snoozedUntil = new Date(Date.now() + 60000).toISOString();
    const snap = buildSnapshot(store, Date.now());
    assert.deepEqual(snap.attention.map(i => i.id), [a.id]);
    assert.deepEqual(snap.snoozed.map(i => i.id), [b.id]);
});

test('persist and load round-trip, and malformed storage falls back to empty', async () => {
    const { api, store } = setup();
    store.attention.push({ id: 'Error:w1:t', type: 'Error', paneID: 'w1', text: 't', createdAt: 't' });
    store.accepted.add('w1');
    store.archived.add('w2');
    store.pinnedOrchestratorPaneID = 'orch';
    store.hiddenWorkspaceID = 'hid';
    store.firstSeen = { w1: '2026-01-01T00:00:00.000Z' };
    await persist(store);
    const fresh = createStore(api);
    await load(fresh);
    assert.equal(fresh.attention.length, 1);
    assert.ok(fresh.accepted.has('w1') && fresh.archived.has('w2'));
    assert.equal(fresh.pinnedOrchestratorPaneID, 'orch');
    assert.equal(fresh.hiddenWorkspaceID, 'hid');
    assert.equal(fresh.firstSeen.w1, '2026-01-01T00:00:00.000Z');
    api.storageMap.set('attention', 'garbage');
    api.storageMap.set('pins', 7);
    const broken = createStore(api);
    await load(broken);
    assert.deepEqual(broken.attention, []);
    assert.equal(broken.pinnedOrchestratorPaneID, null);
});

test('lastLineOf ignores ANSI, blanks and box drawing', () => {
    assert.equal(lastLineOf('one\n\u001b[32mtwo\u001b[0m\n   \n╭────╮\n'), 'two');
    assert.equal(lastLineOf(''), '');
    assert.equal(lastLineOf(null), '');
});
