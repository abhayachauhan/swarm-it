// Finished workers on the rail: the Complete card settles once the result is opened, closed panes get Dismiss.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSwarmApi, MANIFEST } from './backend-fake-api.mjs';
import { registerAll, SNAPSHOT_EVENT } from '../backend/index.mjs';

const lastSnapshot = api => api.emitted.filter(e => e.name === SNAPSHOT_EVENT).at(-1)?.data;
const completeCards = api => lastSnapshot(api).attention.filter(i => i.type === 'Complete');

async function finished(extra = {}) {
    const api = makeSwarmApi({ allowClose: true, files: { '/wt/w1/result.md': '## Goal\nG\n## Done\nD\n## Next\nN\n' }, ...extra });
    const dispose = registerAll(api);
    await dispose.ready;
    await api.upsert('w1', { status: 'waitingForInput' });
    assert.equal(lastSnapshot(api).workers.find(w => w.paneID === 'w1').state, 'done');
    assert.equal(completeCards(api).length, 1, 'a green Complete card at the top');
    return { api, dispose };
}

for (const [command, label] of [['open-thread', 'the thread view'], ['open-result', 'Open'], ['read-result', 'reading the result']]) {
    test(`${label} (${command}) settles the worker's Complete card by itself; the row stays`, async () => {
        const { api, dispose } = await finished();
        assert.equal((await api.command(command, { paneID: 'w1' })).ok, true);
        const snap = lastSnapshot(api);
        assert.equal(completeCards(api).length, 0, 'the card settled');
        const row = snap.workers.find(w => w.paneID === 'w1');
        assert.ok(row && !row.archived, 'the row stays');
        assert.equal(row.state, 'done');
        assert.ok(dispose.store.attention.some(i => i.type === 'Complete' && i.paneID === 'w1' && i.handledAt));
        dispose();
    });
}

test('a refused open leaves the Complete card; an Error card is never settled by opening another worker', async () => {
    const { api, dispose } = await finished();
    const hiddenID = api.paneList.find(p => p.id === 'w2').workspaceID;
    await api.fire('state.changed', { sequence: 900, data: [{ kind: 'pane-removed', workspaceID: hiddenID, paneID: 'w2' }] });
    assert.ok(lastSnapshot(api).attention.some(i => i.type === 'Error' && i.paneID === 'w2'));
    assert.equal((await api.command('read-result', { paneID: 'w2' })).ok, false);
    assert.equal(completeCards(api).length, 1, 'w1 untouched by a failed read of w2');
    await api.command('open-thread', { paneID: 'w1' });
    assert.equal(completeCards(api).length, 0);
    assert.ok(lastSnapshot(api).attention.some(i => i.type === 'Error' && i.paneID === 'w2'), 'the Error card stays');
    dispose();
});

test('a closed pane is marked paneClosed, raises no autohide warning, and Dismiss takes it off the rail without touching the manifest', async () => {
    const storage = new Map();
    const { api, dispose } = await finished({ storage });
    const manifestBefore = api.fileStore['/m/ws1.json'];
    assert.equal((await api.command('dismiss-worker', { paneID: 'w1' })).code, 'PANE_OPEN', 'still open: stop it instead');
    assert.equal((await api.command('dismiss-worker', { paneID: 'stranger' })).code, 'NOT_WORKER');
    assert.equal((await api.command('dismiss-worker', {})).code, 'BAD_ARGS');
    const hiddenID = api.paneList.find(p => p.id === 'w2').workspaceID;
    await api.fire('state.changed', { sequence: 901, data: [{ kind: 'pane-removed', workspaceID: hiddenID, paneID: 'w2' }] });
    let snap = lastSnapshot(api);
    const w2 = snap.workers.find(w => w.paneID === 'w2');
    assert.equal(w2.paneClosed, true);
    assert.equal(w2.state, 'error');
    assert.equal(snap.workers.find(w => w.paneID === 'w1').paneClosed, false);
    assert.equal(snap.warnings.some(w => /pane not in the plugin's pane list/.test(w)), false, snap.warnings.join(' | '));
    assert.ok(snap.attention.some(i => i.type === 'Error' && i.paneID === 'w2'));
    assert.deepEqual(await api.command('dismiss-worker', { paneID: 'w2' }), { ok: true, paneID: 'w2' });
    snap = lastSnapshot(api);
    assert.equal(snap.workers.find(w => w.paneID === 'w2').archived, true, 'off the rail');
    assert.equal(snap.attention.some(i => i.paneID === 'w2'), false, 'its cards settled');
    assert.equal(api.fileStore['/m/ws1.json'], manifestBefore, 'the manifest file is not edited');
    assert.deepEqual(api.destructive, []);
    assert.equal(api.callsTo('panes.close').length, 0, 'nothing to close');
    dispose();
    // Persisted: a reload keeps it dismissed.
    const again = makeSwarmApi({ storage, files: { '/wt/w1/result.md': '# r' } });
    again.paneList.splice(again.paneList.findIndex(p => p.id === 'w2'), 1);
    const reloaded = registerAll(again);
    await reloaded.ready;
    assert.equal(lastSnapshot(again).workers.find(w => w.paneID === 'w2').archived, true);
    reloaded();
});

test('a manifest worker whose pane was never seen is not "closed" and still warns', async () => {
    const manifest = { ...MANIFEST, workers: [...MANIFEST.workers, { paneID: 'w3', label: 'ghost', task: '', resultPath: null, worktreePath: null, parent: null }] };
    const api = makeSwarmApi({ files: { '/m/ws1.json': JSON.stringify(manifest) } });
    const dispose = registerAll(api);
    await dispose.ready;
    const snap = lastSnapshot(api);
    assert.equal(snap.workers.find(w => w.paneID === 'w3').paneClosed, false);
    assert.ok(snap.warnings.some(w => /ghost: pane not in the plugin's pane list/.test(w)), snap.warnings.join(' | '));
    dispose();
});

test('a done worker whose pane closed after writing its result counts as closed, also after a reload', async () => {
    const storage = new Map();
    const { api, dispose } = await finished({ storage });
    const hiddenID = api.paneList.find(p => p.id === 'w1').workspaceID;
    await api.fire('state.changed', { sequence: 902, data: [{ kind: 'pane-removed', workspaceID: hiddenID, paneID: 'w1' }] });
    const w1 = lastSnapshot(api).workers.find(w => w.paneID === 'w1');
    assert.deepEqual([w1.state, w1.paneClosed], ['done', true]);
    dispose();
    const again = makeSwarmApi({ storage, files: { '/wt/w1/result.md': '# r' } });
    again.paneList.splice(again.paneList.findIndex(p => p.id === 'w1'), 1);
    const reloaded = registerAll(again);
    await reloaded.ready;
    const after = lastSnapshot(again).workers.find(w => w.paneID === 'w1');
    assert.deepEqual([after.state, after.paneClosed], ['done', true]);
    assert.equal(lastSnapshot(again).warnings.some(w => /repo-lag: pane not in/.test(w)), false);
    reloaded();
});
