// Pane-id history is capped so plugin storage never fills up, and a refused write never breaks the caller.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, applyStateChange, persist, pruneHistory } from '../backend/store.mjs';
import { makeFakeApi } from './backend-fake-api.mjs';

test('history keeps open and manifest-listed panes, and only the newest closed ones up to the cap', () => {
    const store = createStore(makeFakeApi({}));
    applyStateChange(store, { kind: 'pane-upserted', workspaceID: 'ws', paneID: 'live', pane: { id: 'live', status: 'idle' } });
    store.manifestWorkers = [{ paneID: 'listed' }];
    for (let n = 0; n < 10; n += 1) {
        store.gone.add(`old${n}`);
        store.resultExists.set(`old${n}`, true);
        store.firstSeen[`old${n}`] = new Date(Date.UTC(2026, 0, 1 + n)).toISOString();
    }
    store.gone.add('listed');
    store.resultExists.set('listed', true);
    store.firstSeen.listed = new Date(Date.UTC(2025, 0, 1)).toISOString();
    pruneHistory(store, 3);
    assert.deepEqual([...store.gone], ['old7', 'old8', 'old9', 'listed']);
    assert.deepEqual([...store.resultExists.keys()], ['old7', 'old8', 'old9', 'listed']);
    assert.deepEqual(Object.keys(store.firstSeen).sort(), ['listed', 'live', 'old7', 'old8', 'old9']);
});

test('an oversized manifest, too many workers or a huge task is refused', async () => {
    const { readManifest, validateManifest, MAX_MANIFEST_BYTES } = await import('../backend/manifest.mjs');
    const worker = n => ({ paneID: `p${n}`, label: `w${n}`, task: 't', resultPath: null, worktreePath: null, parent: null });
    const base = { version: 1, orchestrator: { paneID: 'o', label: 'coordinator' } };
    assert.equal(validateManifest({ ...base, workers: [worker(1)] }).ok, true);
    assert.equal(validateManifest({ ...base, workers: Array.from({ length: 501 }, (_, n) => worker(n)) }).ok, false);
    assert.equal(validateManifest({ ...base, workers: [{ ...worker(1), task: 'x'.repeat(1001) }] }).ok, false);
    const api = { files: { read: async () => ' '.repeat(MAX_MANIFEST_BYTES + 1) } };
    assert.match((await readManifest(api, '/m/x.json')).error, /larger than/);
});

test('a storage write that throws is reported, not thrown, and retried on the next persist', async () => {
    const api = makeFakeApi({});
    let fail = true;
    const real = api.storage.set.bind(api.storage);
    api.storage.set = async (key, value) => { if (fail) throw new Error('quota exceeded'); return real(key, value); };
    const store = createStore(api);
    store.gone.add('p1');
    await persist(store);
    assert.match(store.persistError, /quota exceeded/);
    fail = false;
    await persist(store);
    assert.equal(store.persistError, null);
    assert.deepEqual(await api.storage.get('gone'), ['p1']);
});
