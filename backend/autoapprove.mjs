// Auto-approve for unattended (overnight) runs. The user turns it on knowingly: it bypasses their own ask rules.
// Every approval goes through actions.approve, the SAME path as the Approve button (double live capture, hash and
// command match, Enter only). There is no other way to send a key from here. Off by default and after every reload:
// the on/off state is never persisted; only the log is.
import { approve } from './actions.mjs';
import { ownedRequestPane, otherSwarmPane } from './store.mjs';

export const LOG_KEY = 'autoApproveLog';
export const LOG_CAP = 500;
export const DEFAULT_HOURS = 12;
export const MAX_HOURS = 24 * 7;
/** Rate guard: a pane that gets more than RATE_MAX auto-approvals within RATE_WINDOW_MS is paused (its card is left). */
export const RATE_MAX = Number(process.env.SWARM_AUTO_RATE_MAX) || 30;
export const RATE_WINDOW_MS = Number(process.env.SWARM_AUTO_RATE_WINDOW_MS) || 10 * 60 * 1000;
/** The same prompt (same hash) on the same pane is not approved again within this long of an approval: a prompt that
 *  is still showing right after Enter did not take the key, and must not be fed Enter every scan. */
export const SAME_PROMPT_GRACE_MS = Number(process.env.SWARM_AUTO_SAME_PROMPT_GRACE_MS) || 15000;

const fail = (error, code) => ({ ok: false, error, ...(code ? { code } : {}) });
const iso = ms => new Date(ms).toISOString();

export const NEVER_REASON = 'on the never-auto-approve list';
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const INTERPRETERS = /^(?:python[0-9.]*|node|nodejs|perl|ruby|php|deno|bun)$/;
const AWS_WRITE = /^(?:delete|put|create|update|terminate|modify|remove)-/;
const base = token => token.split('/').pop();
/** The command word of a segment: the first token after env assignments and `command`/`exec`/`env`/`nohup`/`time`. */
const commandWord = tokens => tokens.find(t => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) && !['command', 'exec', 'env', 'nohup', 'time', 'builtin'].includes(base(t)));
/** The words after the first `name` token (or after `name -C dir` style options), for a tool's subcommand. */
const after = (tokens, name) => {
    const i = tokens.findIndex(t => base(t) === name);
    return i < 0 ? null : tokens.slice(i + 1);
};
const sub = (tokens, name, verbs) => {
    const rest = after(tokens, name);
    return !!rest && rest.some(t => verbs.includes(t));
};
/**
 * Commands auto-approve never answers, whatever the hour: the card is left for the user. Each rule sees the tokens of
 * one segment of the command (split at && || ; | & newlines $( ) and backticks, quotes dropped) and the whole text.
 * Matching is deliberately broad: a false match only means the user answers that card.
 */
export const NEVER_AUTO_APPROVE = [
    { name: 'rm -r', test: tokens => tokens.some((t, i) => base(t) === 'rm' && tokens.slice(i + 1).some(f => f === '--recursive' || /^-[A-Za-z]*[rR]/.test(f))) },
    { name: 'git push', test: tokens => tokens.some((t, i) => base(t) === 'git' && tokens.slice(i + 1).includes('push')) },
    { name: 'sudo', test: tokens => tokens.some(t => base(t) === 'sudo') },
    { name: 'download piped into a shell', test: (tokens, all) => /\b(?:curl|wget)\b/.test(all) && tokens.some(t => SHELLS.has(base(t))) },
    { name: 'mkfs', test: tokens => tokens.some(t => /^mkfs(?:\.|$)/.test(base(t))) },
    { name: 'dd of=', test: tokens => tokens.some((t, i) => base(t) === 'dd' && tokens.slice(i + 1).some(f => f.startsWith('of='))) },
    { name: 'find -delete or -exec rm', test: tokens => { const rest = after(tokens, 'find'); return !!rest && (rest.includes('-delete') || rest.some((t, i) => ['-exec', '-execdir', '-ok', '-okdir'].includes(t) && base(rest[i + 1] ?? '') === 'rm')); } },
    { name: 'git clean -f', test: tokens => { const rest = after(tokens, 'git'); return !!rest && rest.includes('clean') && rest.some(f => f === '--force' || /^-[A-Za-z]*f/.test(f)); } },
    { name: 'git reset --hard', test: tokens => { const rest = after(tokens, 'git'); return !!rest && rest.includes('reset') && rest.includes('--hard'); } },
    { name: 'git checkout -- . or git restore .', test: tokens => { const rest = after(tokens, 'git'); return !!rest && ((rest.includes('checkout') && rest.includes('--') && rest.includes('.')) || (rest.includes('restore') && rest.includes('.'))); } },
    { name: 'rsync --delete', test: tokens => { const rest = after(tokens, 'rsync'); return !!rest && rest.some(f => f.startsWith('--delete') || f.startsWith('--remove-source-files')); } },
    { name: 'gh pr merge or gh repo delete', test: tokens => { const rest = after(tokens, 'gh'); return !!rest && ((rest.includes('pr') && rest.includes('merge')) || (rest.includes('repo') && rest.includes('delete'))); } },
    { name: 'npm publish', test: tokens => ['npm', 'yarn', 'pnpm'].some(tool => sub(tokens, tool, ['publish'])) },
    { name: 'kubectl write', test: tokens => sub(tokens, 'kubectl', ['delete', 'apply', 'replace', 'scale', 'drain', 'patch', 'edit', 'create']) },
    { name: 'terraform apply or destroy', test: tokens => ['terraform', 'terragrunt', 'tofu'].some(tool => sub(tokens, tool, ['apply', 'destroy'])) },
    { name: 'helm install, upgrade or uninstall', test: tokens => sub(tokens, 'helm', ['install', 'upgrade', 'uninstall', 'delete', 'rollback']) },
    { name: 'aws write', test: tokens => {
        const rest = after(tokens, 'aws');
        if (!rest) return false;
        if (rest.some(t => AWS_WRITE.test(t))) return true;
        const s3 = rest.indexOf('s3');
        const verb = s3 < 0 ? null : rest[s3 + 1];
        return verb === 'rm' || verb === 'mv' || verb === 'rb' || (verb === 'sync' && rest.some(f => f.startsWith('--delete')));
    } },
    { name: 'download piped into an interpreter', test: (tokens, all) => /\b(?:curl|wget)\b/.test(all) && tokens.some(t => INTERPRETERS.test(base(t))) },
    // `R=rm; $R -rf x`: the command word is only known when the shell runs it. `echo $HOME` stays approvable.
    { name: 'command word is a variable', test: tokens => /^\$/.test(commandWord(tokens) ?? '') },
    { name: 'alias or eval', test: tokens => tokens.some(t => ['alias', 'eval'].includes(base(t))) }
];

// Quotes and backslashes are deleted, not spaced, so r"m" -rf and r\m -rf read as rm -rf, as the shell would run them.
const segments = text => text.replace(/["'\\]/g, '').split(/&&|\|\||[;|&\n`]|\$\(|[()]/).map(s => s.trim().split(/\s+/).filter(Boolean)).filter(s => s.length);

/**
 * The name of the never-auto-approve rule a command breaks, or null. A command wrapped over several lines is also
 * checked with its lines joined (with and without a space), so a token split by the wrap is still seen.
 */
export function neverAutoApprove(command) {
    if (typeof command !== 'string' || !command) return null;
    const lines = command.split('\n').map(l => l.trim());
    for (const text of [command, lines.join(' '), lines.join('')]) {
        for (const tokens of segments(text)) {
            const rule = NEVER_AUTO_APPROVE.find(r => r.test(tokens, text));
            if (rule) return rule.name;
        }
    }
    return null;
}

export function createState() {
    return {
        on: false,
        /** ISO end time, or null for "until turned off". */
        until: null,
        since: null,
        approved: 0,
        /** Unrecognised prompts left for the user while on (counted once each). */
        skipped: 0,
        /** Approvals the live check refused (logged with the reason; the card stays). */
        failed: 0,
        /** Persisted, oldest first, capped at LOG_CAP. */
        log: [],
        /** Item ids already attempted: a refused approval is never retried on the same card. */
        tried: new Set(),
        seenUnrecognised: new Set(),
        /** Item ids left because their command is on NEVER_AUTO_APPROVE (counted in skipped and logged once each). */
        seenNever: new Set(),
        /** paneID to approval times inside the rate window. */
        recent: new Map(),
        /** paneID to { hash, at } of its last successful approval (SAME_PROMPT_GRACE_MS). */
        lastApproved: new Map(),
        /** paneID to { paneID, label, reason, at } once the rate guard stopped it. */
        paused: new Map(),
        /** { reason: 'expired' | 'user', at } after the last switch-off, null while on or never used. */
        ended: null,
        /** Bumped by every turnOn and turnOff; run() stops after an await when it changed. */
        generation: 0
    };
}

const validEntry = e => e && typeof e === 'object' && typeof e.at === 'string' && typeof e.paneID === 'string';

/** Load the persisted log. Missing or malformed values fall back to empty. */
export async function load(store) {
    try {
        const raw = await store.api.storage.get(LOG_KEY);
        store.auto.log = (Array.isArray(raw) ? raw : []).filter(validEntry).slice(-LOG_CAP);
    } catch { store.auto.log = []; }
}

async function saveLog(store) {
    try { await store.api.storage.set(LOG_KEY, store.auto.log); } catch { /* the log still lives in memory */ }
}

export async function appendLog(store, entry) {
    store.auto.log.push(entry);
    if (store.auto.log.length > LOG_CAP) store.auto.log.splice(0, store.auto.log.length - LOG_CAP);
    await saveLog(store);
}

export async function clearLog(store) {
    store.auto.log = [];
    await saveLog(store);
}

/** Newest first, for the rail. */
export const logEntries = store => [...store.auto.log].reverse();

/**
 * Turn on for `hours` (default 12; null or 0 means until turned off). Counters, the rate guard and the tried set
 * restart. Already-open recognised cards are approved on the next run.
 */
export function turnOn(store, hours, now = Date.now()) {
    let until = null;
    if (hours === undefined) until = iso(now + DEFAULT_HOURS * 3600000);
    else if (hours === null || hours === 0) until = null;
    else if (typeof hours === 'number' && Number.isFinite(hours) && hours > 0 && hours <= MAX_HOURS) until = iso(now + hours * 3600000);
    else return fail(`hours must be a number between 0 and ${MAX_HOURS} (0 or null: until turned off)`, 'BAD_ARGS');
    const a = store.auto;
    a.on = true; a.until = until; a.since = iso(now); a.ended = null; a.generation += 1;
    a.approved = 0; a.skipped = 0; a.failed = 0;
    a.tried = new Set(); a.seenUnrecognised = new Set(); a.seenNever = new Set(); a.recent = new Map(); a.paused = new Map(); a.lastApproved = new Map();
    return { ok: true };
}

export function turnOff(store, reason, now = Date.now()) {
    const a = store.auto;
    if (!a.on) return false;
    a.on = false; a.until = null; a.generation += 1;
    a.ended = { reason, at: iso(now) };
    return true;
}

/** Switch off by itself once the time ran out. Returns true when it just did. */
export function expireIfDue(store, now = Date.now()) {
    const a = store.auto;
    if (!a.on || !a.until || now < Date.parse(a.until)) return false;
    return turnOff(store, 'expired', now);
}

/** Swarm name and pane label for a Request's pane: the followed swarm's worker or orchestrator, or another swarm's pane. */
export function describePane(store, paneID) {
    const w = store.manifestWorkers.find(x => x.paneID === paneID);
    if (w) return { swarmName: store.workspaceName ?? '', swarmWorkspaceID: store.workspaceID ?? '', label: w.label };
    if (store.orchestrator?.paneID === paneID) return { swarmName: store.workspaceName ?? '', swarmWorkspaceID: store.workspaceID ?? '', label: store.orchestrator.label };
    const other = otherSwarmPane(store, paneID);
    if (other) return { swarmName: other.swarm.name, swarmWorkspaceID: other.swarm.workspaceID, label: other.label };
    return { swarmName: '', swarmWorkspaceID: '', label: store.panes.get(paneID)?.label ?? paneID };
}

/** True when the same pane has an open Request raised after this one: the card is stale and the scan will settle it. */
export const supersededBy = (store, item) => store.attention.some(o => o !== item && o.type === 'Request' && !o.handledAt
    && o.paneID === item.paneID && o.createdAt > item.createdAt);

/**
 * Approve every open, recognised Request from every live swarm through actions.approve. Unrecognised prompts are
 * left for the user and counted once. A refused approval is logged with its reason and the card stays. Snoozed cards
 * are the user's choice and are left alone. Returns true when anything changed (an approval, a count, a pause, expiry).
 */
export async function run(api, store, now = Date.now()) {
    let changed = expireIfDue(store, now);
    const a = store.auto;
    if (!a.on) return changed;
    // index.mjs runs this inside its serial queue, so nothing interleaves; the generation check is belt and braces.
    const generation = a.generation;
    for (const item of [...store.attention]) {
        if (!a.on || a.generation !== generation) break;
        if (item.type !== 'Request' || item.handledAt || item.snoozedUntil) continue;
        if (item.approvable === false) {
            if (!a.seenUnrecognised.has(item.id)) { a.seenUnrecognised.add(item.id); a.skipped += 1; changed = true; }
            continue;
        }
        if (a.tried.has(item.id) || a.paused.has(item.paneID)) continue;
        // A card no gate accepts any more (pane, orchestrator or manifest gone) is settled by the scan, not approved.
        if (!ownedRequestPane(store, item.paneID)) continue;
        // The pane has moved on to a newer prompt (raised by a notification before the scan settled this card): the
        // live check would refuse this one as stale, so leave it for the scan instead of logging a failure.
        if (supersededBy(store, item)) continue;
        // A dangerous command is left as a card for the user, counted in skipped and logged once.
        const never = neverAutoApprove(item.command ?? '');
        if (never) {
            if (!a.seenNever.has(item.id)) {
                a.seenNever.add(item.id); a.skipped += 1; changed = true;
                await appendLog(store, { at: iso(now), ...describePane(store, item.paneID), paneID: item.paneID, command: item.command ?? '', ok: false, skipped: true, reason: NEVER_REASON, rule: never, code: 'NEVER' });
            }
            continue;
        }
        const last = a.lastApproved.get(item.paneID);
        if (last && last.hash === item.promptHash && now - last.at < SAME_PROMPT_GRACE_MS) continue;
        const who = describePane(store, item.paneID);
        const stamps = (a.recent.get(item.paneID) ?? []).filter(t => now - t < RATE_WINDOW_MS);
        if (stamps.length >= RATE_MAX) {
            a.paused.set(item.paneID, { paneID: item.paneID, label: who.label, at: iso(now), reason: `more than ${RATE_MAX} auto-approvals in ${Math.round(RATE_WINDOW_MS / 60000)} minutes; its cards are left for you` });
            changed = true;
            continue;
        }
        a.tried.add(item.id);
        const result = await approve(api, store, item.id, item.promptHash);
        if (a.generation !== generation) break;
        if (result.ok) {
            a.approved += 1; stamps.push(now); a.recent.set(item.paneID, stamps);
            a.lastApproved.set(item.paneID, { hash: item.promptHash, at: now });
        } else a.failed += 1;
        await appendLog(store, {
            at: iso(now), ...who, paneID: item.paneID, command: item.command ?? '', ok: result.ok === true,
            ...(result.ok ? {} : { reason: result.error ?? 'refused', code: result.code ?? '' })
        });
        changed = true;
    }
    return changed;
}

/** The part of the snapshot views see (contracts/state.d.ts AutoApproveState). */
export function snapshotPart(store) {
    const a = store.auto;
    return {
        on: a.on, until: a.until, since: a.since, approved: a.approved, skipped: a.skipped, failed: a.failed,
        logCount: a.log.length, paused: [...a.paused.values()], ended: a.ended
    };
}
