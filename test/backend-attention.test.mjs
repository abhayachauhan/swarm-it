import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, load, persist } from '../backend/store.mjs';
import { createAttention, addItem, handleItem, snoozeItem, rearm, visibleItems, snoozedItems, stop } from '../backend/attention.mjs';
import { makeFakeApi } from './backend-fake-api.mjs';

function setup(storage) {
    const api = makeFakeApi({ storage });
    const store = createStore(api);
    const att = createAttention(api, store);
    return { api, store, att };
}
const T0 = Date.parse('2026-01-01T00:00:00Z');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

test('snooze stores an absolute due time and the item returns when due (acceptance 3)', async () => {
    const { api, att } = setup();
    const { item } = await addItem(att, { type: 'Error', paneID: 'w1', text: 'boom', now: T0 });
    const snoozed = await snoozeItem(att, item.id, 15, T0);
    assert.equal(snoozed.snoozedUntil, '2026-01-01T00:15:00.000Z');
    assert.equal(api.storageMap.get('attention')[0].snoozedUntil, '2026-01-01T00:15:00.000Z');
    assert.equal(visibleItems(att, T0 + 60000).length, 0);
    assert.equal(snoozedItems(att, T0 + 60000).length, 1);
    assert.equal(visibleItems(att, T0 + 15 * 60000).length, 1, 'visible again at the due time without any timer');
    stop(att);
});

test('a snooze set before a plugin reload still returns on time (rearm)', async () => {
    const storage = new Map();
    const first = setup(storage);
    const { item } = await addItem(first.att, { type: 'Request', paneID: 'w1', text: 'asks', command: 'ls', now: T0 });
    const due = Date.now() + 80;
    // Simulate: snooze then reload. The first runtime (and its timers) is discarded.
    await snoozeItem(first.att, item.id, 0, T0);
    first.store.attention[0].snoozedUntil = new Date(due).toISOString();
    await persist(first.store);
    stop(first.att);

    const second = setup(storage);
    await load(second.store);
    let notified = 0;
    second.att.onChange = () => { notified += 1; };
    const result = rearm(second.att, Date.now());
    assert.deepEqual(result.armed, [item.id], 'future snooze re-armed');
    assert.equal(visibleItems(second.att, Date.now()).length, 0, 'still hidden before due');
    await sleep(200);
    assert.equal(visibleItems(second.att, Date.now()).length, 1, 'returned after its due time');
    assert.equal(second.store.attention[0].snoozedUntil, undefined);
    assert.ok(notified >= 1, 'listeners told so a snapshot is pushed');
    stop(second.att);
});

test('rearm clears snoozes that came due while the plugin was down', async () => {
    const storage = new Map();
    const first = setup(storage);
    const { item } = await addItem(first.att, { type: 'Error', paneID: 'w1', text: 'boom', now: T0 });
    await snoozeItem(first.att, item.id, 5, T0);
    stop(first.att);
    const second = setup(storage);
    await load(second.store);
    const result = rearm(second.att, T0 + 10 * 60000);
    assert.deepEqual(result.returned, [item.id]);
    assert.equal(visibleItems(second.att, T0 + 10 * 60000).length, 1);
});

test('handled items are not re-armed and a handled item cannot be snoozed', async () => {
    const { att } = setup();
    const { item } = await addItem(att, { type: 'Complete', paneID: 'w1', text: 'x', now: T0 });
    await snoozeItem(att, item.id, 5, T0);
    await handleItem(att, item.id, T0);
    assert.equal(att.timers.size, 0);
    assert.equal(await snoozeItem(att, item.id, 5, T0), null);
    assert.deepEqual(rearm(att, T0), { returned: [], armed: [] });
});
