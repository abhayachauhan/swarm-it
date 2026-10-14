// Auto-clean: finished workers are closed after `autoCleanMinutes`, and old `<name> · workers` workspaces go once empty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, applyStateChange } from '../backend/store.mjs';
import { createAttention, addItem } from '../backend/attention.mjs';
import { autoClean, removeEmptyLegacy, BATCH_PER_SCAN } from '../backend/workers.mjs';
import { makeFakeApi, makeSwarmApi } from './backend-fake-api.mjs';

const MIN = 60000;
const W1 = { paneID: 'w1', label: 'repo-lag', resultPath: '/wt/w1/result.md', worktreePath: '/wt/w1' };
const W2 = { paneID: 'w2', label: 'tests', resultPath: null, worktreePath: null };

function setup({ status = 'idle', settings = {}, gitStatus = { '/wt/w1': { kind: 'clean' } }, closeFails = false } = {}) {
    const api = makeFakeApi({ allowClose: true, closeFails, gitStatus });
    const store = createStore(api);
    store.att = createAttention(api, store);
    store.settings = { ...store.settings, ...settings };
    applyStateChange(store, { kind: 'pane-upserted', workspaceID: 'wsW', paneID: 'w1', pane: { id: 'w1', status } });
    store.resultExists.set('w1', true);
    return { api, store };
}

test('a finished worker is closed only once it has been finished for the delay (10 minutes by default)', async () => {
    const { api, store } = setup();
    assert.deepEqual((await autoClean(api, store, [W1], 0)).cleaned, []);
    assert.deepEqual((await autoClean(api, store, [W1], 10 * MIN - 1)).cleaned, [], 'not before the delay');
    await addItem(store.att, { type: 'Complete', paneID: 'w1', text: 'repo-lag finished' });
    const result = await autoClean(api, store, [W1], 10 * MIN);
    assert.deepEqual(result.cleaned, ['w1']);
    assert.deepEqual(api.callsTo('panes.close').map(c => c.args[0]), ['w1']);
    assert.ok(store.archived.has('w1'), 'it leaves the swarm');
    assert.equal(store.attention.filter(i => i.paneID === 'w1' && !i.handledAt).length, 0, 'its cards are settled');
    assert.deepEqual((await autoClean(api, store, [W1], 30 * MIN)).cleaned, [], 'never twice');
});

test('running, waiting and errored workers with an open pane are never closed', async () => {
    for (const status of ['running', 'waitingForInput']) {
        const { api, store } = setup({ status });
        if (status === 'waitingForInput') store.resultExists.set('w1', false);
        await autoClean(api, store, [W1], 0);
        assert.deepEqual((await autoClean(api, store, [W1], 60 * MIN)).cleaned, [], status);
    }
    const { api, store } = setup();
    store.errored.add('w1');
    await autoClean(api, store, [W1], 0);
    assert.deepEqual((await autoClean(api, store, [W1], 60 * MIN)).cleaned, [], 'errored');
    assert.deepEqual(api.callsTo('panes.close'), []);
});

test('a worker that starts running again restarts its delay', async () => {
    const { api, store } = setup();
    await autoClean(api, store, [W1], 0);
    store.panes.get('w1').status = 'running';
    await autoClean(api, store, [W1], 5 * MIN);
    store.panes.get('w1').status = 'idle';
    await autoClean(api, store, [W1], 6 * MIN);
    assert.deepEqual((await autoClean(api, store, [W1], 15 * MIN)).cleaned, [], '9 minutes since it finished again');
    assert.deepEqual((await autoClean(api, store, [W1], 16 * MIN)).cleaned, ['w1']);
});

test('a dirty worktree, or an unknown git status, keeps the worker and tries again after another delay', async () => {
    const { api, store } = setup({ gitStatus: { '/wt/w1': { kind: 'dirty', changedFiles: 2 } } });
    await autoClean(api, store, [W1], 0);
    const first = await autoClean(api, store, [W1], 10 * MIN);
    assert.deepEqual(first.cleaned, []);
    assert.match(first.kept[0].error, /uncommitted changes \(2 files\)/);
    assert.equal(first.kept[0].label, 'repo-lag');
    assert.deepEqual((await autoClean(api, store, [W1], 11 * MIN)).kept, [], 'no git call on every scan');
    api.gitStatus['/wt/w1'] = { kind: 'clean' };
    assert.deepEqual((await autoClean(api, store, [W1], 20 * MIN)).cleaned, ['w1']);

    const unknown = setup({ gitStatus: {} });
    await autoClean(unknown.api, unknown.store, [W1], 0);
    assert.match((await autoClean(unknown.api, unknown.store, [W1], 10 * MIN)).kept[0].error, /unknown/);
    assert.deepEqual(unknown.api.callsTo('panes.close'), []);
});

test('a refused close keeps the worker in the swarm', async () => {
    const { api, store } = setup({ closeFails: true });
    await autoClean(api, store, [W1], 0);
    const result = await autoClean(api, store, [W1], 10 * MIN);
    assert.deepEqual(result.cleaned, []);
    assert.match(result.kept[0].error, /close failed/);
    assert.equal(store.archived.has('w1'), false);
});

test('a worker whose pane already closed is removed from the swarm with nothing to close', async () => {
    const { api, store } = setup();
    store.gone.add('w2');
    await autoClean(api, store, [W2], 0);
    assert.deepEqual((await autoClean(api, store, [W2], 10 * MIN)).cleaned, ['w2']);
    assert.ok(store.archived.has('w2'));
    assert.deepEqual(api.callsTo('panes.close'), []);
    assert.deepEqual(api.callsTo('services.call'), [], 'no git check for a closed pane');
});

test('at most BATCH_PER_SCAN panes are closed per call; the rest go on the next calls', async () => {
    const { api, store } = setup();
    const many = Array.from({ length: 20 }, (_, n) => ({ paneID: `p${n}`, label: `p${n}`, resultPath: null, worktreePath: null }));
    for (const w of many) {
        applyStateChange(store, { kind: 'pane-upserted', workspaceID: 'wsW', paneID: w.paneID, pane: { id: w.paneID, status: 'idle' } });
        store.resultExists.set(w.paneID, true);
    }
    await autoClean(api, store, many, 0);
    assert.equal((await autoClean(api, store, many, 10 * MIN)).cleaned.length, BATCH_PER_SCAN);
    assert.equal((await autoClean(api, store, many, 10 * MIN)).cleaned.length, BATCH_PER_SCAN);
    assert.equal((await autoClean(api, store, many, 10 * MIN)).cleaned.length, 20 - 2 * BATCH_PER_SCAN);
    assert.equal(api.callsTo('panes.close').length, 20);
});

test('autoCleanMinutes 0 turns it off; another number changes the delay', async () => {
    const off = setup({ settings: { autoCleanMinutes: 0 } });
    await autoClean(off.api, off.store, [W1], 0);
    assert.deepEqual((await autoClean(off.api, off.store, [W1], 999 * MIN)).cleaned, []);
    const two = setup({ settings: { autoCleanMinutes: 2 } });
    await autoClean(two.api, two.store, [W1], 0);
    assert.deepEqual((await autoClean(two.api, two.store, [W1], 2 * MIN)).cleaned, ['w1']);
});

test('only empty, inactive "<name> · workers" workspaces are removed, each tried once', async () => {
    const api = makeFakeApi({
        workspaces: [
            { id: 'empty', name: 'Swarm · workers', paneCount: 0, isActive: false },
            { id: 'full', name: 'Other · workers', paneCount: 1, isActive: false },
            { id: 'onscreen', name: 'Third · workers', paneCount: 0, isActive: true },
            { id: 'shared', name: 'Workers', paneCount: 0, isActive: false },
            { id: 'mine', name: 'Swarm', paneCount: 0, isActive: false }
        ]
    });
    const removed = [];
    api.workspaces.remove = async id => { removed.push(id); };
    const store = createStore(api);
    assert.deepEqual(await removeEmptyLegacy(api, store), ['empty']);
    assert.deepEqual(await removeEmptyLegacy(api, store), [], 'tried once');
    assert.deepEqual(removed, ['empty']);
});

test('a pane in Workers listed by two manifests is trusted by neither swarm, so it is never closed', async () => {
    const { otherSwarmPane } = await import('../backend/store.mjs');
    const { api, store } = setup();
    store.workspaceNames.set('wsW', 'Workers');
    const own = { workspaceID: 'wsA', name: 'A', orchestrator: { paneID: 'oA' }, workers: [W1] };
    const rogue = { workspaceID: 'wsB', name: 'B', orchestrator: { paneID: 'oB' }, workers: [{ ...W1, label: 'stolen' }] };
    for (const [id, ws] of [['oA', 'wsA'], ['oB', 'wsB']]) applyStateChange(store, { kind: 'pane-upserted', workspaceID: ws, paneID: id, pane: { id, status: 'idle' } });
    store.swarms = [own];
    assert.equal(otherSwarmPane(store, 'w1')?.swarm.name, 'A', 'one claim: trusted');
    store.swarms = [own, rogue];
    assert.equal(otherSwarmPane(store, 'w1'), null, 'two claims: refused');
    assert.deepEqual(api.callsTo('panes.close'), []);
});

test('through the plugin: a finished worker is closed after the delay; the coordinator and other panes never are', async () => {
    const api = makeSwarmApi({ allowClose: true, w1Status: 'idle', files: { '/wt/w1/result.md': '## Goal\nG\n' } });
    process.env.SWARM_PROMPT_SCAN_MS = '20';
    const { registerAll } = await import('../backend/index.mjs');
    const dispose = registerAll(api);
    await dispose.ready;
    const st = dispose.store;
    const until = async cond => { for (let n = 0; n < 100 && !cond(); n += 1) await new Promise(resolve => setTimeout(resolve, 10)); };
    await until(() => st.doneSince.has('w1'));
    assert.ok(st.doneSince.has('w1'), 'the finished worker is timed');
    assert.deepEqual(api.callsTo('panes.close'), [], 'not closed before the delay');
    st.doneSince.set('w1', Date.now() - 11 * MIN);
    await until(() => api.callsTo('panes.close').length > 0);
    assert.deepEqual(api.callsTo('panes.close').map(c => c.args[0]), ['w1']);
    assert.ok(st.archived.has('w1'));
    dispose();
});
