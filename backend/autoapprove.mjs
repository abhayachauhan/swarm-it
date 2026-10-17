// Auto-approve for unattended (overnight) runs. The user turns it on knowingly: it bypasses their own ask rules.
// Two ways to answer, never both at once. With swarm-it the active kelpi.agent.permissions provider, `decide` answers
// Claude's PermissionRequest hook from the real tool input and the screen path sends no key. Otherwise every approval
// goes through actions.approve, the SAME path as the Approve button (double live capture, hash and command match,
// Enter only). Off by default and after every reload: the on/off state is never persisted; only the log is.
import { posix } from 'node:path';
import { realpath, lstat } from 'node:fs/promises';
import { approve } from './actions.mjs';
import { ownedRequestPane, otherSwarmPane } from './store.mjs';
import { withTimeout, READ_TIMEOUT_MS } from './safepath.mjs';
import { judgeCommand, NEVER_AUTO_APPROVE as KELPI_NEVER } from './kelpi-policy.mjs';

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

/** Kelpi 0.2.18+: Claude's PermissionRequest hook asks the selected provider of this service (Kelpi docs/plugin-services.md). */
export const PERMISSIONS_SERVICE = 'kelpi.agent.permissions';
export const PROVIDER_ID = 'local.swarm-view.permissions';
export const SELECT_COMMAND = `kelpi plugin service-select ${PERMISSIONS_SERVICE} ${PROVIDER_ID}`;
const FIX = `run "${SELECT_COMMAND}" and "kelpi install-hooks", then restart Claude sessions`;
/** While the provider is active, a recognised card this old on a pane `decide` never heard about is logged once (NOT_ASKED). */
export const NOT_ASKED_GRACE_MS = Number(process.env.SWARM_NOT_ASKED_GRACE_MS) || 6000;
/** A decision for the pane this long before its card was raised still counts as Kelpi having asked. */
const ASKED_WINDOW_MS = 60000;
/** Longer tool input is left for the user unread, so `decide` stays well inside Kelpi's 2 second deadline: the never
 *  list reads the whole text once per segment, so 16 KiB of `a;a;…` took 1.6 s, 4 KiB about 0.1 s. */
export const MAX_REQUEST_TEXT = 4096;
/** Finding where a write lands may take this long in all; slower (a hung network mount) and the write waits for the user. */
export const PATH_CHECK_MS = Number(process.env.SWARM_PATH_CHECK_MS) || 500;
/** A hung lookup holds one of libuv's 4 threads, so once this many outlive their time no new ones start. */
const MAX_STUCK_LOOKUPS = 2;
/** Provider log entries keep this many characters of the command. */
const LOG_TEXT_CAP = 1000;
const ABSTAIN = Object.freeze({ behavior: 'abstain' });

const fail = (error, code) => ({ ok: false, error, ...(code ? { code } : {}) });
const iso = ms => new Date(ms).toISOString();
const message = error => String(error?.message ?? error);

export const NEVER_REASON = 'on the never-auto-approve list';
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const INTERPRETERS = /^(?:python[0-9.]*|node|nodejs|perl|ruby|php|deno|bun)$/;
const AWS_WRITE = /^(?:delete|put|create|update|terminate|modify|remove)-/;
// zsh runs `=rm` as rm, and macOS file names ignore case (`Rm` is /bin/rm), so both are folded away.
const base = token => token.split('/').pop().replace(/^=+/, '').toLowerCase();
const WRAPPERS = ['command', 'exec', 'env', 'nohup', 'time', 'builtin'];
/**
 * The command word of a segment: the first token after env assignments and `command`/`exec`/`env`/`nohup`/`time`,
 * skipping the wrappers' own options (`time -p`, `env -i`, `exec -a name`).
 */
const commandWord = tokens => {
    let wrapped = false;
    for (let i = 0; i < tokens.length; i += 1) {
        const t = tokens[i];
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue;
        if (WRAPPERS.includes(base(t))) { wrapped = true; continue; }
        // Wrapper options that take a separate value: `exec -a name`, `env -u VAR`, `env -C dir`, `time -f fmt -o file`.
        if (wrapped && t.startsWith('-')) { if (['-a', '-u', '-C', '-f', '-o', '--unset', '--chdir', '--format', '--output'].includes(t)) i += 1; continue; }
        return t;
    }
    return undefined;
};
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
    { name: 'rm -r', test: tokens => tokens.some((t, i) => base(t) === 'rm' && tokens.slice(i + 1).some(f => /^--rec/.test(f) || /^-[A-Za-z]*[rR]/.test(f))) },
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
    { name: 'alias or eval', test: tokens => tokens.some(t => ['alias', 'eval'].includes(base(t))) },
    // `{rm,-rf,x}`, `rm -${X:-rf} d`, `git ${x}push`: the shell builds the real word, so the rules above cannot see it.
    { name: 'shell expansion builds a word', test: tokens => /[{$]/.test(commandWord(tokens) ?? '')
        || tokens.some(t => /\$\{[^}]*[-:=?+#%/^,]/.test(t) || (t.startsWith('-') && t.includes('$')) || /[A-Za-z0-9_]\$|\}[A-Za-z]/.test(t)) },
    // `echo <base64> | base64 -d | sh`: anything piped into a shell or interpreter, not just a download.
    // `bash -c "$(… | base64 -d)"`, `bash <(…)`, `bash <<< …`: a shell or interpreter fed code generated on the spot.
    { name: 'shell fed generated code', test: (tokens, all) => {
        const word = base(commandWord(tokens) ?? '');
        return (SHELLS.has(word) || INTERPRETERS.test(word)) && /\$\(|`|<\(|<<|\bbase64\b|\bxxd\b|\bprintf\b/.test(all);
    } },
    // `$(echo rm) -rf x`: the command word itself comes from a substitution.
    { name: 'command word from a substitution', test: (tokens, all) => /(?:^|&&|\|\||[;&|\n(])\s*(?:\$\(|`)/.test(all) },
    // `$'\x72m'`: ANSI-C escapes spell a word this check cannot read.
    { name: 'ANSI-C escape', test: (tokens, all) => /\$'[^']*\\/.test(all) },
    // `echo -rf x | xargs rm`: the flags arrive on stdin.
    { name: 'xargs or parallel running rm', test: tokens => tokens.some((t, i) => ['xargs', 'parallel'].includes(base(t)) && tokens.slice(i + 1).some(f => base(f) === 'rm')) },
    // `git -c alias.p=push p`: an alias defined inline can be any git command or a shell (`!sh`).
    { name: 'git -c alias', test: tokens => { const rest = after(tokens, 'git'); return !!rest && rest.some(t => /^alias\./i.test(t) || /^--config-env/.test(t)); } },
    // `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git p`: git config, aliases included, from the environment.
    { name: 'git config from the environment', test: tokens => tokens.some(t => /^GIT_CONFIG(?:_[A-Z0-9_]*)?=/.test(t)) },
    // `env -S 'rm -rf x'` splits one string into a whole command this check never sees as words.
    { name: 'env -S', test: tokens => tokens.some((t, i) => base(t) === 'env' && tokens.slice(i + 1).some(f => /^-[A-Za-z]*S|^--split-string/.test(f))) },
    // Read the way `segments` reads it (quotes and backslashes deleted), so `| "sh"`, `| s\h`, `|& sh` or `| command sh` count.
    { name: 'piped into a shell or interpreter', test: (tokens, all) => {
        const word = base(commandWord(tokens) ?? '');
        if (!SHELLS.has(word) && !INTERPRETERS.test(word)) return false;
        return all.replace(/["'\\]/g, '').split(/(?<!\|)\|(?!\|)/).slice(1).some(part =>
            base(commandWord(part.replace(/^&/, '').split(/&&|\|\||[;&\n`]|\$\(|[()]/)[0].trim().split(/\s+/).filter(Boolean)) ?? '') === word);
    } }
];

// Quotes and backslashes are deleted, not spaced, so r"m" -rf and r\m -rf read as rm -rf, as the shell would run them.
// `$'rm'` and `$"rm"` are quoted words: drop the `$` so they read as rm, not as a variable.
const segments = text => text.replace(/\$(?=['"])/g, '').replace(/["'\\]/g, '').split(/&&|\|\||[;|&\n`]|\$\(|[()]/).map(s => s.trim().split(/\s+/).filter(Boolean)).filter(s => s.length);

/**
 * The name of the never-auto-approve rule a command breaks, or null. A command wrapped over several lines is also
 * checked with its lines joined (with and without a space), so a token split by the wrap is still seen.
 */
export function neverAutoApprove(command) {
    if (typeof command !== 'string' || !command) return null;
    // Backslash-newline is a line continuation: the shell joins the halves with nothing between them.
    command = command.replace(/\\\r?\n/g, '');
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
        generation: 0,
        /** performance.now() at which `until` falls, so setting the clock back cannot extend a run; null with until. */
        deadline: null,
        /** registered: `decide` is registered with Kelpi. active: Kelpi lists it as the active provider (checkProvider).
         *  warning: the one-line fix while it is not active. */
        provider: { registered: false, active: false, warning: null, checkedAt: 0 },
        /** paneID to the last time `decide` was called for it, on or off. */
        asked: new Map(),
        /** Card ids logged once as NOT_ASKED while the provider is active. */
        seenNotAsked: new Set()
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
export function turnOn(store, hours, now = Date.now(), mono = performance.now()) {
    let endAt = null;
    if (hours === undefined) endAt = now + DEFAULT_HOURS * 3600000;
    else if (hours === null || hours === 0) endAt = null;
    else if (typeof hours === 'number' && Number.isFinite(hours) && hours > 0 && hours <= MAX_HOURS) endAt = now + hours * 3600000;
    else return fail(`hours must be a number between 0 and ${MAX_HOURS} (0 or null: until turned off)`, 'BAD_ARGS');
    const a = store.auto;
    a.on = true; a.since = iso(now); a.ended = null; a.generation += 1;
    setUntil(store, endAt, now, mono);
    a.approved = 0; a.skipped = 0; a.failed = 0;
    a.tried = new Set(); a.seenUnrecognised = new Set(); a.seenNever = new Set(); a.recent = new Map(); a.paused = new Map(); a.lastApproved = new Map();
    a.seenNotAsked = new Set();
    return { ok: true };
}

/** The end of the run: `until` on the wall clock (shown, and ends a run the Mac slept through) and `deadline` on the monotonic one. */
export function setUntil(store, endAt, now = Date.now(), mono = performance.now()) {
    const a = store.auto;
    a.until = endAt === null ? null : iso(endAt);
    a.deadline = endAt === null ? null : mono + (endAt - now);
}

export function turnOff(store, reason, now = Date.now()) {
    const a = store.auto;
    if (!a.on) return false;
    a.on = false; a.until = null; a.deadline = null; a.generation += 1;
    a.ended = { reason, at: iso(now) };
    return true;
}

/** Switch off by itself once the time ran out on either clock. Returns true when it just did. */
export function expireIfDue(store, now = Date.now(), mono = performance.now()) {
    const a = store.auto;
    if (!a.on || !a.until) return false;
    if (now < Date.parse(a.until) && !(a.deadline !== null && mono >= a.deadline)) return false;
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
    // Kelpi asks `decide` directly: the screen never presses Enter for auto-approve, so no prompt is answered twice.
    if (a.provider.active) return (await noteNotAsked(store, now)) || changed;
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
                await appendLog(store, { at: iso(now), ...describePane(store, item.paneID), paneID: item.paneID, command: item.command ?? '', ok: false, skipped: true, reason: NEVER_REASON, rule: never, code: 'NEVER', source: 'screen' });
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
            ...(result.ok ? {} : { reason: result.error ?? 'refused', code: result.code ?? '' }), source: 'screen'
        });
        changed = true;
    }
    return changed;
}

/**
 * Provider active: a recognised card that sat NOT_ASKED_GRACE_MS on a pane `decide` never heard about comes from a Claude
 * session without the PermissionRequest hook (hooks load when Claude starts). Logged and counted once; the card stays.
 */
async function noteNotAsked(store, now) {
    const a = store.auto;
    let changed = false;
    for (const item of [...store.attention]) {
        if (item.type !== 'Request' || item.handledAt || item.snoozedUntil || item.approvable === false) continue;
        if (a.seenNotAsked.has(item.id) || !ownedRequestPane(store, item.paneID)) continue;
        const created = Date.parse(item.createdAt);
        if (!(now - created >= NOT_ASKED_GRACE_MS)) continue;
        const asked = a.asked.get(item.paneID);
        if (asked !== undefined && asked >= created - ASKED_WINDOW_MS) continue;
        a.seenNotAsked.add(item.id); a.skipped += 1; changed = true;
        await appendLog(store, {
            at: iso(now), ...describePane(store, item.paneID), paneID: item.paneID, command: item.command ?? '', ok: false, skipped: true,
            reason: 'Kelpi never asked swarm-it about this prompt: restart Claude in this pane (hooks load at start) or run "kelpi install-hooks"',
            code: 'NOT_ASKED', source: 'screen'
        });
    }
    return changed;
}

/** The input field each tool's prompt shows, for the tools whose prompt the screen path recognises (notify.mjs HEADER). */
const SCREEN_TOOLS = new Map([['Bash', 'command'], ['Edit', 'file_path'], ['MultiEdit', 'file_path'], ['Write', 'file_path'], ['Read', 'file_path'], ['WebFetch', 'url']]);
const WRITES = new Set(['Edit', 'MultiEdit', 'Write']);
const KELPI_NEVER_PREFIX = 'never auto-approved: ';
const KELPI_CODES = { 'multi-line command': 'MULTILINE', 'command too long': 'TOO_LONG', 'no command': 'NO_INPUT' };
/** Control characters: the screen path never approves a prompt holding one, and a newline can start a second command. */
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/;
/** Writes that change what Claude, git, a shell or launchd runs next, read on the path in lower case with `..` and symlinks
 *  resolved (macOS paths ignore case). Kelpi's agent settings rule is checked too. */
const WRITE_NEVER = [
    { name: '.claude or .codex folder, or .mcp.json', test: path => /(?:^|\/)\.(?:claude|codex)[^/]*\/|(?:^|\/)\.mcp\.json$/.test(path) },
    { name: 'git hooks or config', test: path => /(?:^|\/)\.git(?:$|\/(?:.*\/)?(?:hooks\/|config(?:\.worktree)?$))|(?:^|\/)\.gitconfig$|\/\.config\/git\//.test(path) },
    { name: 'shell startup file', test: path => /(?:^|\/)\.(?:zshrc|zshenv|zprofile|zlogin|zlogout|bashrc|bash_profile|bash_login|bash_logout|profile|envrc)$|\/\.config\/fish\//.test(path) },
    { name: 'launch agent', test: path => /\/library\/launch(?:agents|daemons)\//.test(path) }
];
/** Every string in a tool's input, keys included, however deep. */
const strings = (value, out = []) => {
    if (typeof value === 'string') out.push(value);
    else if (value !== null && typeof value === 'object') for (const [key, inner] of Object.entries(value)) { out.push(key); strings(inner, out); }
    return out;
};
const PATH_FS = { realpath, lstat };
const MISSING = new Set(['ENOENT', 'ENOTDIR']);
let stuckLookups = 0;
/** One file system lookup, given until `end`; one that outlives it counts as stuck until it finally returns. */
function lookup(fn, path, end) {
    let late = false;
    const run = Promise.resolve().then(() => fn(path)).finally(() => { if (late) stuckLookups -= 1; });
    return withTimeout(run, Math.max(1, end - performance.now()), 'checking where a write lands').catch(error => {
        if (error.code === 'TIMEOUT') { late = true; stuckLookups += 1; }
        throw error;
    });
}
/** Where an absolute path lands, symlinks resolved through its nearest existing folder: `{ path }`, or why it can't be told. */
async function realPath(path, fs) {
    const end = performance.now() + PATH_CHECK_MS;
    const unknown = error => ({ code: 'PATH', reason: `could not tell where it writes (${error.code ?? message(error)})` });
    let dir = path;
    let rest = '';
    for (;;) {
        if (stuckLookups >= MAX_STUCK_LOOKUPS) return { code: 'PATH', reason: 'earlier path lookups are still stuck' };
        try { return { path: posix.join(await lookup(fs.realpath, dir, end), rest) }; } catch (error) {
            if (!MISSING.has(error.code)) return unknown(error);
        }
        // A dangling symlink points at a target only the write would create.
        try { if ((await lookup(fs.lstat, dir, end)).isSymbolicLink()) return { code: 'SYMLINK', reason: 'writes through a symlink that points nowhere yet' }; } catch (error) {
            if (!MISSING.has(error.code)) return unknown(error);
        }
        rest = posix.join(posix.basename(dir), rest);
        dir = posix.dirname(dir);
    }
}

/**
 * Policy for one structured request: `{ allow: true, text }` or `{ allow: false, text, reason, code, rule? }`. `text` is
 * what the prompt would show. Bash: swarm-it's never list, then Kelpi's example policy (union, never weaker). Other
 * tools: the same tool types the screen path approves today ("Tool use" is an MCP tool), never with a control character,
 * with the never list on their text (and on each string of an MCP call); writes to agent, git or shell config are left,
 * and so is a write whose path is not absolute or cannot be followed in time. `fs` is for tests.
 */
export async function judgeRequest(toolName, toolInput, fs = PATH_FS) {
    const input = toolInput !== null && typeof toolInput === 'object' && !Array.isArray(toolInput) ? toolInput : null;
    const mcp = typeof toolName === 'string' && /^mcp__./.test(toolName);
    const field = SCREEN_TOOLS.get(toolName);
    if (!input || (!field && !mcp)) return { allow: false, text: '', reason: `auto-approve does not answer ${typeof toolName === 'string' ? toolName : 'this'} requests`, code: 'TOOL' };
    // As Claude's "Tool use" prompt draws an MCP call, `server - tool(key: "value", …)`, so the never list splits it the same way.
    const text = mcp ? `${toolName}(${Object.entries(input).map(([key, value]) => `${key}: ${typeof value === 'string' ? `"${value}"` : JSON.stringify(value)}`).join(', ')})` : input[field];
    if (typeof text !== 'string' || !text.trim()) return { allow: false, text: '', reason: `no ${field}`, code: 'NO_INPUT' };
    // Claude asks before running a command outside its sandbox: that prompt is the user's, whatever the command.
    if (toolName === 'Bash' && input.dangerouslyDisableSandbox) return { allow: false, text, reason: 'asks to run outside the sandbox', code: 'SANDBOX' };
    if (text.length > MAX_REQUEST_TEXT) return { allow: false, text, reason: 'too long to check', code: 'TOO_LONG' };
    // JSON escapes would hide a newline from the never list (`ls\ngit push`), so each raw string is checked as well.
    const parts = mcp ? strings(input) : [];
    if (toolName !== 'Bash' && [text, ...parts].some(part => CONTROL.test(part))) return { allow: false, text, reason: 'holds a control character', code: 'CONTROL' };
    for (const part of [text, ...parts]) {
        const never = neverAutoApprove(part);
        if (never) return { allow: false, text, reason: NEVER_REASON, code: 'NEVER', rule: never };
    }
    if (toolName === 'Bash') {
        const judged = judgeCommand(text);
        if (judged.allow) return { allow: true, text };
        if (judged.reason.startsWith(KELPI_NEVER_PREFIX)) return { allow: false, text, reason: NEVER_REASON, code: 'NEVER', rule: judged.reason.slice(KELPI_NEVER_PREFIX.length) };
        return { allow: false, text, reason: judged.reason, code: KELPI_CODES[judged.reason] ?? 'NEVER' };
    }
    if (WRITES.has(toolName)) {
        // Claude sends absolute paths; anything else could not be followed through its symlinks.
        if (!text.startsWith('/')) return { allow: false, text, reason: 'not an absolute path', code: 'PATH' };
        const landed = await realPath(posix.normalize(text), fs);
        if (!landed.path) return { allow: false, text, reason: landed.reason, code: landed.code };
        const real = landed.path;
        const paths = [text, ...new Set([posix.normalize(text).toLowerCase(), real.toLowerCase(), real])];
        const settings = KELPI_NEVER.find(r => r.name === 'agent settings write');
        if (paths.some(p => settings.test([p], p))) return { allow: false, text, reason: NEVER_REASON, code: 'NEVER', rule: settings.name };
        const rule = WRITE_NEVER.find(r => paths.some(p => r.test(p.toLowerCase())));
        if (rule) return { allow: false, text, reason: NEVER_REASON, code: 'NEVER', rule: rule.name };
    }
    return { allow: true, text };
}

/**
 * The kelpi.agent.permissions@1 `decide`. Allow only while the window is on (checked on both clocks every call), swarm-it is
 * the active provider and the request passes judgeRequest and the rate guard; otherwise abstain, so Claude shows its own
 * prompt and the rail's card works as before. Never denies, never rejects, awaits only a write's path lookup (at most
 * PATH_CHECK_MS). Every decision made while on is logged with `source: 'provider'`; while off it abstains without logging.
 */
export async function decide(store, args, now = Date.now(), mono = performance.now()) {
    const a = store.auto;
    let paneID = '?';
    let tool = '';
    let text = '';
    try {
        paneID = typeof args?.paneID === 'string' && args.paneID ? args.paneID : '?';
        tool = typeof args?.toolName === 'string' ? args.toolName : '';
        a.asked.set(paneID, now);
        expireIfDue(store, now, mono);
        if (!a.on) return ABSTAIN;
        const entry = (fields) => void appendLog(store, {
            at: iso(now), ...describePane(store, paneID), paneID, command: text.length > LOG_TEXT_CAP ? `${text.slice(0, LOG_TEXT_CAP)}…` : text,
            tool, source: 'provider', ...fields
        });
        const leave = (reason, code, extra = {}) => { a.skipped += 1; entry({ ok: false, skipped: true, reason, code, ...extra }); return ABSTAIN; };
        const judged = await judgeRequest(args.toolName, args.toolInput, a.fs);
        // Turned off while a path was being looked up: off means abstain, unlogged.
        if (!a.on) return ABSTAIN;
        text = judged.text;
        // Kelpi only asks the selected provider, but until checkProvider confirms it, the screen path is the one answering.
        if (!a.provider.active) { entry({ ok: false, reason: 'swarm-it is not confirmed as the active provider yet; the screen path answers', code: 'NOT_ACTIVE' }); return ABSTAIN; }
        if (args.agent !== 'claude') return leave('not a Claude pane', 'AGENT');
        if (!judged.allow) return leave(judged.reason, judged.code, judged.rule ? { rule: judged.rule } : {});
        const stamps = (a.recent.get(paneID) ?? []).filter(t => now - t < RATE_WINDOW_MS);
        if (!a.paused.has(paneID) && stamps.length >= RATE_MAX) {
            a.paused.set(paneID, { paneID, label: describePane(store, paneID).label, at: iso(now), reason: `more than ${RATE_MAX} auto-approvals in ${Math.round(RATE_WINDOW_MS / 60000)} minutes; its prompts are left for you` });
        }
        if (a.paused.has(paneID)) return leave('paused by the rate guard', 'PAUSED');
        a.approved += 1; stamps.push(now); a.recent.set(paneID, stamps);
        entry({ ok: true });
        return { behavior: 'allow' };
    } catch (error) {
        try {
            if (a.on) void appendLog(store, { at: iso(now), swarmName: '', swarmWorkspaceID: '', label: paneID, paneID, command: '', tool, source: 'provider', ok: false, reason: `error: ${message(error)}`, code: 'ERROR' });
        } catch { /* abstain all the same */ }
        return ABSTAIN;
    }
}

/**
 * Whether Kelpi asks swarm-it's provider, from `api.services.list()`; sets `provider.active` and the one-line `warning`.
 * Returns true when either changed. Never throws: any failure leaves the screen path answering.
 */
export async function checkProvider(api, store, now = Date.now()) {
    const p = store.auto.provider;
    let active = false;
    let warning = null;
    if (!p.registered) warning = `Auto-approve reads the screen: this Kelpi cannot take permission decisions from plugins (0.2.18 or later can); after updating, ${FIX}`;
    else {
        try {
            const services = await withTimeout(Promise.resolve().then(() => api.services.list()), READ_TIMEOUT_MS, 'listing services');
            const service = (Array.isArray(services) ? services : []).find(s => s?.id === PERMISSIONS_SERVICE);
            if (!service) warning = `Auto-approve reads the screen: this Kelpi has no ${PERMISSIONS_SERVICE} service; update Kelpi, then ${FIX}`;
            else if (service.activeProviderID === PROVIDER_ID) active = true;
            else if (service.selectedProviderID === PROVIDER_ID) warning = `Auto-approve reads the screen: swarm-it is the selected permissions provider but Kelpi asks ${service.activeProviderID ?? 'none'}; reload the plugin, or ${FIX}`;
            else warning = `Auto-approve reads the screen: swarm-it is not the selected permissions provider; ${FIX}`;
        } catch (error) {
            warning = `Auto-approve reads the screen: could not check the permissions provider (${message(error)}); ${FIX}`;
        }
    }
    p.checkedAt = now;
    const changed = p.active !== active || p.warning !== warning;
    p.active = active; p.warning = warning;
    return changed;
}

/** The part of the snapshot views see (contracts/state.d.ts AutoApproveState). */
export function snapshotPart(store) {
    const a = store.auto;
    return {
        on: a.on, until: a.until, since: a.since, approved: a.approved, skipped: a.skipped, failed: a.failed,
        logCount: a.log.length, paused: [...a.paused.values()], ended: a.ended, provider: providerPart(a)
    };
}

/** contracts/state.d.ts AutoApproveState.provider: which path answers, and the fix while it is the screen. */
export const providerPart = a => ({ active: a.provider.active, warning: a.provider.warning });
