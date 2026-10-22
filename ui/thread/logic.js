// Pure helpers for the thread view. No DOM access. Text returned here is always rendered with textContent.

export const SECTION_NAMES = ['goal', 'done', 'next'];
export const FALLBACK_LINES = 40;

const HEADING = /^\s{0,3}#{1,6}\s+(goal|done|next)\b[\s:.\-]*#*\s*$/i;
const BOLD_ONLY = /^\s*(?:[-*]\s+)?\*\*\s*(goal|done|next)\s*:?\s*\*\*\s*:?\s*$/i;
const BOLD_INLINE = /^\s*(?:[-*]\s+)?\*\*\s*(goal|done|next)\s*:?\s*\*\*\s*[:\-—]?\s*(\S.*)$/i;
const ANY_HEADING = /^\s{0,3}#{1,6}\s+\S/;
const ANY_BOLD_ONLY = /^\s*\*\*[^*]+\*\*\s*:?\s*$/;
const FENCE = /^\s*(```|~~~)/;

/** Returns { name, rest } when the line opens a Goal/Done/Next section, else null. */
export function sectionStart(line) {
    let m = HEADING.exec(line);
    if (m) return { name: m[1].toLowerCase(), rest: '' };
    m = BOLD_ONLY.exec(line);
    if (m) return { name: m[1].toLowerCase(), rest: '' };
    m = BOLD_INLINE.exec(line);
    if (m) return { name: m[1].toLowerCase(), rest: m[2] };
    return null;
}

/** Any other heading or bold-only line closes the current section. */
function closesSection(line) {
    return ANY_HEADING.test(line) || ANY_BOLD_ONLY.test(line);
}

export function firstLines(text, count = FALLBACK_LINES) {
    if (typeof text !== 'string' || text === '') return '';
    return text.split(/\r?\n/).slice(0, count).join('\n').trimEnd();
}

/**
 * Parse Goal, Done and Next out of a result file.
 * Returns { goal, done, next, found, fallback }. `found` is true when at least one section exists.
 * `fallback` holds the first 40 lines when none do (and is '' otherwise).
 */
export function parseSummary(text) {
    const out = { goal: '', done: '', next: '', found: false, fallback: '' };
    if (typeof text !== 'string' || text.trim() === '') return out;
    const buckets = { goal: [], done: [], next: [] };
    const seen = new Set();
    let current = null;
    let inFence = false;
    for (const line of text.split(/\r?\n/)) {
        if (FENCE.test(line)) {
            inFence = !inFence;
            if (current) buckets[current].push(line);
            continue;
        }
        if (inFence) {
            if (current) buckets[current].push(line);
            continue;
        }
        const start = sectionStart(line);
        if (start) {
            // Only the first occurrence of each section counts.
            current = seen.has(start.name) ? null : start.name;
            seen.add(start.name);
            if (current && start.rest) buckets[current].push(start.rest);
            continue;
        }
        if (closesSection(line)) {
            current = null;
            continue;
        }
        if (current) buckets[current].push(line);
    }
    for (const name of SECTION_NAMES) {
        out[name] = buckets[name].join('\n').trim();
        if (seen.has(name)) out.found = true;
    }
    if (!out.found || SECTION_NAMES.every(name => out[name] === '')) {
        out.found = SECTION_NAMES.some(name => out[name] !== '');
    }
    if (!out.found) out.fallback = firstLines(text);
    return out;
}

export function findWorker(snapshot, paneID) {
    if (!snapshot || !Array.isArray(snapshot.workers)) return null;
    return snapshot.workers.find(worker => worker.paneID === paneID) ?? null;
}

/** Latest unhandled Request item for a pane, or null. Snapshot.attention is already unhandled and not snoozed. */
export function pendingRequest(snapshot, paneID) {
    if (!snapshot || !Array.isArray(snapshot.attention)) return null;
    const items = snapshot.attention.filter(item => item.paneID === paneID && item.type === 'Request' && !item.handledAt);
    return items.length ? items[items.length - 1] : null;
}

export function formatElapsed(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '';
    const s = Math.floor(seconds);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

const STATE_LABELS = { running: 'Running', waiting: 'Waiting for you', done: 'Done', error: 'Error' };
export function stateLabel(state) {
    return STATE_LABELS[state] ?? 'Unknown';
}

/** Which actions are meaningful for a worker. Backend still enforces refusals. */
export function availableActions(worker) {
    if (!worker) return { accept: false, requestChanges: false, dismiss: false, terminal: false, send: false, sendLabel: 'Send' };
    const finished = worker.state === 'done' || worker.state === 'error';
    return {
        accept: finished && !worker.accepted,
        requestChanges: true,
        dismiss: !worker.archived,
        terminal: true,
        send: true,
        sendLabel: worker.agent === 'codex' ? 'Queue for Codex' : finished ? 'Send and restart' : 'Send',
    };
}

/** Trim a composer message. Returns '' when there is nothing to send. */
export function normalizeMessage(text) {
    return typeof text === 'string' ? text.trim() : '';
}

/** Split result prose into plain text and safe web links without interpreting HTML or Markdown. */
export function linkSegments(text) {
    if (typeof text !== 'string' || !text) return [];
    const segments = [];
    const pattern = /\[([^\]\n]+)\]\((https?:\/\/[^\s)`]+)\)|(https?:\/\/[^\s<>"'`\])]+)/gi;
    let start = 0;
    for (const match of text.matchAll(pattern)) {
        const at = match.index;
        if (at > start) segments.push({ text: text.slice(start, at) });
        const raw = match[2] ?? match[3];
        const url = raw.replace(/[.,;:!?]+$/, '');
        let safe = false;
        try {
            const parsed = new URL(url);
            safe = (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname)
                && !parsed.username && !parsed.password && url.length <= 2048;
        } catch { /* leave malformed URLs as text */ }
        if (safe) {
            segments.push({ text: match[1] ?? url, url });
            if (url.length < raw.length) segments.push({ text: raw.slice(url.length) });
        } else segments.push({ text: match[0] });
        start = at + match[0].length;
    }
    if (start < text.length) segments.push({ text: text.slice(start) });
    return segments;
}

/** Error text from a CommandResult-ish value, or '' when ok. */
export function resultError(result) {
    if (result && result.ok === true) return '';
    if (result && typeof result.error === 'string' && result.error) return result.error;
    return 'Command failed';
}

/** Read the worker pane id from the view state. */
export function paneIDFromState(state) {
    return state && typeof state.paneID === 'string' && state.paneID !== '' ? state.paneID : null;
}

export const LOCK_MS = 500;

/**
 * Approve and Deny stay disabled for LOCK_MS after the pending Request, its prompt, or its position in the attention list
 * changes, so a click aimed at one prompt cannot land on another that replaced it under the pointer.
 */
export function createChangeLock(delayMs = LOCK_MS) {
    let key = null;
    let since = 0;
    return {
        /** Record the pending request at nowMs. A null request clears the lock state. */
        observe(snapshot, paneID, nowMs) {
            const item = pendingRequest(snapshot, paneID);
            const next = item ? `${item.id}|${item.promptHash ?? ''}|${snapshot.attention.indexOf(item)}` : null;
            if (next !== key) { key = next; since = nowMs; }
        },
        locked(nowMs) { return key !== null && nowMs - since < delayMs; },
        remaining(nowMs) { return key === null ? 0 : Math.max(0, delayMs - (nowMs - since)); },
    };
}

/** The coordinator's pane id from the snapshot, or null. "Back to coordinator" sends open-thread for it, which closes this view. */
export function coordinatorPaneID(snapshot) {
    const id = snapshot?.orchestrator?.paneID;
    return typeof id === 'string' && id !== '' ? id : null;
}

/** "label (paneID)" so the user sees which pane a permission request comes from, not just a name. */
export function requestOrigin(worker, item) {
    const paneID = item?.paneID ?? worker?.paneID ?? '';
    const label = worker?.label;
    return label && label !== paneID ? `${label} (${paneID})` : paneID;
}
