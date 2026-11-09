import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, load } from '../backend/store.mjs';
import { createAttention, addItem, handleItem, visibleItems } from '../backend/attention.mjs';
import { makeFakeApi } from './backend-fake-api.mjs';

function setup(storage) {
    const api = makeFakeApi({ storage });
    const store = createStore(api);
    const att = createAttention(api, store);
    return { api, store, att };
}
const T0 = Date.parse('2026-01-01T00:00:00Z');

test('items persist until handled and carry the id format', async () => {
    const { api, att } = setup();
    const { item } = await addItem(att, { type: 'Request', paneID: 'w1', text: 'asks', command: 'ls', now: T0 });
    assert.equal(item.id, 'Request:w1:2026-01-01T00:00:00.000Z');
    assert.equal(api.storageMap.get('attention').length, 1, 'written to plugin storage');
    assert.equal(visibleItems(att, T0).length, 1);
    await handleItem(att, item.id, T0 + 1000);
    assert.equal(visibleItems(att, T0 + 1000).length, 0);
    assert.equal(api.storageMap.get('attention')[0].handledAt, '2026-01-01T00:00:01.000Z');
    assert.equal(await handleItem(att, 'nope', T0), null);
});

test('addItem dedupes unhandled items of the same type and pane, but not different commands', async () => {
    const { att } = setup();
    const a = await addItem(att, { type: 'Complete', paneID: 'w1', text: 'x', now: T0 });
    const b = await addItem(att, { type: 'Complete', paneID: 'w1', text: 'x', now: T0 + 5 });
    assert.equal(b.added, false);
    assert.equal(b.item.id, a.item.id);
    await addItem(att, { type: 'Request', paneID: 'w1', text: 'x', command: 'ls', now: T0 });
    assert.equal((await addItem(att, { type: 'Request', paneID: 'w1', text: 'x', command: 'ls', now: T0 })).added, false);
    assert.equal((await addItem(att, { type: 'Request', paneID: 'w1', text: 'x', command: 'rm', now: T0 })).added, true);
    // once handled, a new one is allowed
    await handleItem(att, a.item.id, T0);
    assert.equal((await addItem(att, { type: 'Complete', paneID: 'w1', text: 'again', now: T0 + 9 })).added, true);
});

test('unhandled items survive a plugin reload and handled ones stay handled', async () => {
    const storage = new Map();
    const first = setup(storage);
    const open = await addItem(first.att, { type: 'Error', paneID: 'w1', text: 'boom', now: T0 });
    const done = await addItem(first.att, { type: 'Complete', paneID: 'w2', text: 'x', now: T0 });
    await handleItem(first.att, done.item.id, T0 + 1000);
    const second = setup(storage);
    await load(second.store);
    assert.deepEqual(visibleItems(second.att).map(i => i.id), [open.item.id]);
    assert.equal(second.store.attention.find(i => i.id === done.item.id).handledAt, '2026-01-01T00:00:01.000Z');
});
