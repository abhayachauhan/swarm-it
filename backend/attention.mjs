// Attention items (Request, Error, Complete) kept in store.attention and persisted until handled.
import { persist } from './store.mjs';

const HANDLED_KEEP_MS = 24 * 3600 * 1000;
export const ATTENTION_TYPES = ['Request', 'Error', 'Complete'];

export function toMs(now) {
    if (now === undefined || now === null) return Date.now();
    if (typeof now === 'number') return now;
    if (now instanceof Date) return now.getTime();
    const parsed = Date.parse(now);
    return Number.isNaN(parsed) ? Date.now() : parsed;
}

/** @returns {{ api: object, store: object, onChange: (() => void) | null }} */
export function createAttention(api, store) {
    const att = { api, store, onChange: null };
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
        ...(item.agent === 'codex' && item.nativeQuestion ? { nativeQuestion: item.nativeQuestion } : {}),
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
    await persist(att.store);
    changed(att);
    return item;
}

/** Unhandled items, oldest first. */
export function visibleItems(att) {
    return att.store.attention
        .filter(i => !i.handledAt)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** Drop handled items older than a day. Returns the number removed. */
export function pruneHandled(att, now) {
    const cutoff = toMs(now) - HANDLED_KEEP_MS;
    const before = att.store.attention.length;
    att.store.attention = att.store.attention.filter(i => !i.handledAt || Date.parse(i.handledAt) > cutoff);
    return before - att.store.attention.length;
}
