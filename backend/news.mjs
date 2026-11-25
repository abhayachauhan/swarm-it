// Worker news for the coordinator: one JSON line per real event in <manifestDir>/news/<pane-id>.jsonl, read by
// `swarm-wait --any`. Kinds: blocked, error, turn-done, exited. Only swarm workers get a file, never a coordinator.
// Every caller runs on the plugin's serial queue, so one file has one writer at a time.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { manifestDirectory, isSafeLabel } from './manifest.mjs';
import { refreshResult } from './store.mjs';

export const MAX_LINES = 200;
export const MAX_TEXT_CHARS = 200;
/** Far above MAX_LINES lines of the longest text; a bigger file was not written by this plugin, so only its tail is kept. */
const MAX_READ_BYTES = 1024 * 1024;
const PANE_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
/** Control characters, Unicode line and paragraph separators, and unpaired surrogates. */
const UNPRINTABLE = /[\p{Cc}\p{Zl}\p{Zp}\p{Cs}]+/gu;

export const newsDirectory = (store, home = homedir()) => join(manifestDirectory(home, store.settings?.manifestDir), 'news');

/** One plain line of at most MAX_TEXT_CHARS: no escape codes, control characters or line breaks. */
export function plainText(text) {
    const flat = String(text ?? '').replace(ANSI, '').replace(UNPRINTABLE, ' ').replace(/\s+/g, ' ').trim();
    if (flat.length <= MAX_TEXT_CHARS) return flat;
    let cut = '';
    for (const char of flat) {
        if (cut.length + char.length > MAX_TEXT_CHARS - 1) break;
        cut += char;
    }
    return `${cut}…`;
}

/** The manifest worker for a pane, in the followed swarm or another live one; null for coordinators and strangers. */
export function newsWorker(store, paneID) {
    if (typeof paneID !== 'string' || !PANE_ID.test(paneID)) return null;
    const coordinators = [store.manifest?.orchestrator, ...store.swarms.map(s => s.orchestrator)];
    if (coordinators.some(o => o?.paneID === paneID)) return null;
    return store.manifestWorkers.find(w => w.paneID === paneID) ?? store.swarms.flatMap(s => s.workers).find(w => w.paneID === paneID) ?? null;
}

/** The worker's result path once its result exists; '' before that. */
export async function resultNote(store, worker) {
    if (!worker.resultPath) return '';
    await refreshResult(store, worker);
    return store.resultExists.get(worker.paneID) === true ? worker.resultPath : '';
}

/** The tail of a regular file, opened without following a symlink; '' when there is none. */
async function readTail(path) {
    let handle;
    try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const info = await handle.stat();
        if (!info.isFile()) return '';
        const length = Math.min(info.size, MAX_READ_BYTES);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, info.size - length);
        const text = buffer.toString('utf8', 0, bytesRead);
        return info.size > length ? text.slice(text.indexOf('\n') + 1) : text;
    } catch (error) {
        if (error?.code === 'ENOENT') return '';
        throw error;
    } finally { await handle?.close(); }
}

async function writeOnce(path, data, flags) {
    const handle = await open(path, flags | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink > 1) throw new Error('not a private regular file');
        // One write call, so a reader never sees half a line.
        await handle.write(data);
    } finally { await handle.close(); }
}

const lastAt = lines => {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
            const at = Date.parse(JSON.parse(lines[i]).at);
            if (Number.isFinite(at)) return at;
        } catch { /* a torn or foreign line */ }
    }
    return null;
};

async function append(dir, paneID, line, now) {
    await mkdir(dir, { recursive: true });
    if (!(await lstat(dir)).isDirectory()) throw new Error('the news directory is not a real directory');
    const path = join(dir, `${paneID}.jsonl`);
    // A symlink, hard link, FIFO or the like left at this path is removed, never written through.
    const found = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (found && !(found.isFile() && found.nlink === 1)) await rm(path);
    const text = await readTail(path);
    const lines = text.split('\n').filter(Boolean);
    const previous = lastAt(lines);
    // Strictly increasing within the file: the reader remembers the last `at` it reported.
    const at = new Date(previous === null ? now : Math.max(now, previous + 1)).toISOString();
    const entry = `${JSON.stringify({ at, ...line })}\n`;
    const torn = text !== '' && !text.endsWith('\n');
    if (lines.length < MAX_LINES) {
        await writeOnce(path, `${torn ? '\n' : ''}${entry}`, constants.O_APPEND | constants.O_CREAT);
        return;
    }
    // Over the cap: replace the file in one rename, keeping the newest lines.
    const temporary = join(dir, `.${paneID}.${randomUUID()}.tmp`);
    try {
        await writeOnce(temporary, `${lines.slice(-(MAX_LINES - 1)).join('\n')}\n${entry}`, constants.O_CREAT | constants.O_EXCL);
        await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
}

/**
 * Append one news line for a worker pane. Never throws: news must not break state handling.
 * @returns {Promise<boolean>} true when a line was written
 */
export async function writeNews(store, paneID, kind, text, now = Date.now()) {
    const worker = newsWorker(store, paneID);
    if (!worker) return false;
    const line = { pane: paneID, label: isSafeLabel(worker.label) ? worker.label : '', kind, text: plainText(text) };
    try {
        await append(newsDirectory(store), paneID, line, now);
        record(store, 'written', { paneID, kind });
        return true;
    } catch (error) {
        record(store, 'write-failed', { paneID, kind, error: String(error?.message ?? error) });
        return false;
    }
}

/** The kind of the newest line in a pane's file; null when there is none or it cannot be read. */
export async function lastNewsKind(store, paneID) {
    if (typeof paneID !== 'string' || !PANE_ID.test(paneID)) return null;
    try {
        const lines = (await readTail(join(newsDirectory(store), `${paneID}.jsonl`))).split('\n').filter(Boolean);
        return JSON.parse(lines.at(-1) ?? 'null')?.kind ?? null;
    } catch { return null; }
}

/** Structured local counters, as for worker placement. */
function record(store, event, fields) {
    const count = (store.placementCounts.get(`news.${event}`) ?? 0) + 1;
    store.placementCounts.set(`news.${event}`, count);
    console.info(JSON.stringify({ event: `swarm.news.${event}`, count, ...fields }));
}
