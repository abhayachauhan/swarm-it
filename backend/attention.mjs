// Attention items (Request, Error, Complete) kept in store.attention and persisted until handled.
// Snooze stores an ABSOLUTE due time; rearm() re-creates timers after a plugin reload.
import { persist } from './store.mjs';

const MAX_TIMEOUT = 2 ** 31 - 1;
const HANDLED_KEEP_MS = 24 * 3600 * 1000;
export const ATTENTION_TYPES = ['Request', 'Error', 'Complete'];

export function toMs(now) {
    if (now === undefined || now === null) return Date.now();
    if (typeof now === 'number') return now;
    if (now instanceof Date) return now.getTime();
    const parsed = Date.parse(now);
    return Number.isNaN(parsed) ? Date.now() : parsed;
}

/** @returns {{ api: object, store: object, timers: Map<string, any>, onChange: (() => void) | null }} */
export function createAttention(api, store) {
    const att = { api, store, timers: new Map(), onChange: null };
    store.att = att;
    return att;
}

const changed = att => { try { att.onChange?.(); } catch { /* a listener must not break state handling */ } };

/**
 * Add an item. Dedupe: an unhandled item with the same type and pane (and the same command for a Request) is kept
 * and returned instead of adding another.
 * @returns {Promise<{ added: boolean, item: object }>}
 */
export async function addItem(att, item) {
    const items = att.store.attention;
    const existing = items.find(i => !i.handledAt && i.type === item.type && i.paneID === item.paneID
        && (item.type !== 'Request' || ((i.command ?? '') === (item.command ?? '') && (i.promptHash ?? '') === (item.promptHash ?? ''))));
    if (existing) return { added: false, item: existing };
    if (!ATTENTION_TYPES.includes(item.type) || !item.paneID) throw new Error('attention item needs a type and paneID');
    const createdAt = item.createdAt ?? new Date(toMs(item.now)).toISOString();
    const created = {
        id: `${item.type}:${item.paneID}:${createdAt}`,
        type: item.type, paneID: item.paneID, text: item.text ?? '', createdAt,
        ...(item.command ? { command: item.command } : {}),
        ...(item.promptHash ? { promptHash: item.promptHash } : {}),
        ...(typeof item.promptBlock === 'string' && item.promptBlock ? { promptBlock: item.promptBlock } : {}),
        ...(item.approvable === false ? { approvable: false } : {}),
        ...(item.agent === 'codex' ? { agent: 'codex' } : {}),
        ...(typeof item.swarmName === 'string' && item.swarmName ? { swarmName: item.swarmName } : {}),
        ...(typeof item.swarmWorkspaceID === 'string' && item.swarmWorkspaceID ? { swarmWorkspaceID: item.swarmWorkspaceID } : {})
    };
    let id = created.id;
    for (let n = 2; items.some(i => i.id === id); n += 1) id = `${created.id}#${n}`;
    created.id = id;
    items.push(created);
    await persist(att.store);
    changed(att);
    return { added: true, item: created };
}

/** Mark handled (approved, denied, accepted or cleared). Returns the item or null. */
export async function handleItem(att, itemID, now) {
    const item = att.store.attention.find(i => i.id === itemID);
    if (!item) return null;
    if (!item.handledAt) item.handledAt = new Date(toMs(now)).toISOString();
    delete item.snoozedUntil;
    disarm(att, itemID);
    await persist(att.store);
    changed(att);
    return item;
}

/** Snooze an unhandled item for `minutes`. Stores the absolute due time. Returns the item or null. */
export async function snoozeItem(att, itemID, minutes, now) {
    const item = att.store.attention.find(i => i.id === itemID);
    if (!item || item.handledAt) return null;
    const dueMs = toMs(now) + Math.max(0, minutes) * 60000;
    item.snoozedUntil = new Date(dueMs).toISOString();
    arm(att, item, toMs(now));
    await persist(att.store);
    changed(att);
    return item;
}

function disarm(att, itemID) {
    const timer = att.timers.get(itemID);
    if (timer) clearTimeout(timer);
    att.timers.delete(itemID);
}

function arm(att, item, nowMs) {
    disarm(att, item.id);
    const wait = Date.parse(item.snoozedUntil) - nowMs;
    const timer = setTimeout(async () => {
        att.timers.delete(item.id);
        if (item.handledAt || !item.snoozedUntil) return;
        if (Date.parse(item.snoozedUntil) > Date.now()) { arm(att, item, Date.now()); return; }
        delete item.snoozedUntil;
        try { await persist(att.store); } catch { /* the item still returns in memory */ }
        changed(att);
    }, Math.min(Math.max(wait, 0), MAX_TIMEOUT));
    timer.unref?.();
    att.timers.set(item.id, timer);
}

/**
 * Call on activation (and after load): snoozes already due are cleared, the rest get fresh timers.
 * setTimeout does not survive a reload, the stored due time does.
 * @returns {{ returned: string[], armed: string[] }}
 */
export function rearm(att, now) {
    const nowMs = toMs(now);
    for (const id of [...att.timers.keys()]) disarm(att, id);
    const returned = [];
    const armed = [];
    for (const item of att.store.attention) {
        if (item.handledAt || !item.snoozedUntil) continue;
        if (Date.parse(item.snoozedUntil) <= nowMs) { delete item.snoozedUntil; returned.push(item.id); }
        else { arm(att, item, nowMs); armed.push(item.id); }
    }
    if (returned.length) changed(att);
    return { returned, armed };
}

/** Unhandled items that are not snoozed into the future, oldest first. */
export function visibleItems(att, now) {
    const nowMs = toMs(now);
    return att.store.attention
        .filter(i => !i.handledAt && (!i.snoozedUntil || Date.parse(i.snoozedUntil) <= nowMs))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** Unhandled items still snoozed. */
export function snoozedItems(att, now) {
    const nowMs = toMs(now);
    return att.store.attention
        .filter(i => !i.handledAt && i.snoozedUntil && Date.parse(i.snoozedUntil) > nowMs)
        .sort((a, b) => a.snoozedUntil.localeCompare(b.snoozedUntil));
}

/** Drop handled items older than a day. Returns the number removed. */
export function pruneHandled(att, now) {
    const cutoff = toMs(now) - HANDLED_KEEP_MS;
    const before = att.store.attention.length;
    att.store.attention = att.store.attention.filter(i => !i.handledAt || Date.parse(i.handledAt) > cutoff);
    return before - att.store.attention.length;
}

/** Stop all timers (dispose). */
export function stop(att) {
    for (const id of [...att.timers.keys()]) disarm(att, id);
}
