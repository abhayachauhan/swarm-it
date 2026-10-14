// Kelpi stops a plugin that sends over 512 messages in one second. Settling many cards at once must stay far below that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSwarmApi, makeFakeApi } from './backend-fake-api.mjs';
import { registerAll } from '../backend/index.mjs';
import { createStore, persist } from '../backend/store.mjs';

const outgoing = api => api.calls.filter(c => ['storage.set', 'emit', 'contributions.update'].includes(c.name)).length;

test('persist writes only the keys whose value changed', async () => {
    const api = makeFakeApi();
    const store = createStore(api);
    await persist(store);
    const first = api.callsTo('storage.set').length;
    assert.ok(first >= 10, 'the first save writes every key');
    await persist(store);
    assert.equal(api.callsTo('storage.set').length, first, 'nothing changed, nothing written');
    store.archived.add('w9');
    await persist(store);
    assert.deepEqual(api.callsTo('storage.set').slice(first).map(c => c.args[0]), ['archived']);
});

test('a pane closing with 60 open cards settles them all in a handful of messages', async () => {
    const api = makeSwarmApi();
    const dispose = registerAll(api);
    await dispose.ready;
    for (let n = 0; n < 60; n += 1) {
        dispose.store.attention.push({ id: `Request:w2:${n}`, type: 'Request', paneID: 'w2', text: '', createdAt: new Date().toISOString(), promptHash: `h${n}` });
    }
    const before = outgoing(api);
    const hiddenID = api.paneList.find(p => p.id === 'w2').workspaceID;
    await api.fire('state.changed', { sequence: 950, data: [{ kind: 'pane-removed', workspaceID: hiddenID, paneID: 'w2' }] });
    assert.equal(dispose.store.attention.filter(i => i.paneID === 'w2' && i.type === 'Request' && !i.handledAt).length, 0, 'every card settled');
    const sent = outgoing(api) - before;
    assert.ok(sent < 140, `sent ${sent} messages for 60 cards`);
    dispose();
});
