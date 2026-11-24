// Auto-approve for unattended (overnight) runs. The user turns it on knowingly: it bypasses their own ask rules.
// Two ways to answer, never both at once. With swarm-it the active kelpi.agent.permissions provider, `decide` answers
// Claude's PermissionRequest hook from the real tool input and the screen path sends no key. Otherwise every approval
// goes through actions.approve, the SAME path as the Approve button (double live capture, hash and command match,
// Enter only). Off by default and after every reload: the on/off state is never persisted; only the log is.
import { posix } from 'node:path';
import { realpath, lstat, stat } from 'node:fs/promises';
import { approve } from './actions.mjs';
import { actionableWorker, ownedRequestPane, otherSwarmPane } from './store.mjs';
import { withTimeout, READ_TIMEOUT_MS } from './safepath.mjs';
import { judgeCommand, neverAutoApprove as kelpiNever, NEVER_AUTO_APPROVE as KELPI_NEVER } from './kelpi-policy.mjs';
import { inertCurlBodies, inertQuoted, quietGrepPatterns, stripHeredocs, unrollLoops } from './floor-helpers.mjs';
import { commandIndex, floorExecRule, kelpiFloorRule, runsFile } from './floor-exec.mjs';

export const LOG_KEY = 'autoApproveLog';
export const LOG_CAP = 500;
/** The user's saved on/off choice; absent means on. */
export const ENABLED_KEY = 'autoApproveEnabled';
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
/** An AWS CLI operation that only reads. Anything else (`start-image-pipeline-execution`, `invoke`, `send-command`) may change state. */
const AWS_READ_OP = /^(?:describe|list|get|head|batch-get|search|lookup|query|scan|select|check|validate|simulate|estimate|filter|tail|wait)(?:-|$)/;
/** Operation names that change state, for an `aws` that is not itself the command run (`bash -c "aws …"`, `xargs aws …`, `ssh host aws …`). */
const AWS_WRITE_OP = /^(?:delete|put|create|update|terminate|modify|remove|start|stop|run|invoke|send|publish|attach|detach|associate|disassociate|enable|disable|register|deregister|reboot|cancel|tag|untag|reset|restore|revoke|authorize|import|export|copy|deploy|package|execute|apply|add|set|rotate|replace|release|allocate|change|abort|accept|reject|schedule|submit|admin|batch-(?:write|delete|put|update)|generate|upload|attach|detach|reboot|activate|deactivate|rollback|promote|failover|resize|scale|truncate|purge|empty|flush|drain)(?:-|$)/;
/** Services of the AWS CLI that this repo's work touches, for an `aws` passed to another command. */
const AWS_SERVICES = new Set(['ec2', 's3api', 'iam', 'ssm', 'lambda', 'ecs', 'eks', 'ecr', 'rds', 'dynamodb', 'cloudformation', 'logs', 'sqs', 'sns', 'kms',
    'secretsmanager', 'route53', 'cloudfront', 'elbv2', 'elb', 'autoscaling', 'imagebuilder', 'events', 'stepfunctions', 'codebuild', 'codepipeline', 'apigateway',
    'apigatewayv2', 'organizations', 'sso', 'ssm-contacts', 'acm', 'wafv2', 'cloudwatch', 'athena', 'glue', 'kinesis', 'firehose', 'elasticache', 'efs', 'backup',
    'guardduty', 'securityhub', 'config', 'cloudtrail', 'sesv2', 'ses', 'ebs', 'batch', 'emr', 'redshift', 'opensearch', 'es', 'kafka', 'mq', 'transfer']);
/** Global `aws` options that take a separate value. */
const AWS_VALUE_OPTIONS = new Set(['--profile', '--region', '--output', '--query', '--endpoint-url', '--ca-bundle', '--cli-read-timeout', '--cli-connect-timeout', '--color', '--cli-binary-format']);
/** First words of a segment whose arguments are text, so an `aws` among them is a word, not a command. */
const AWS_TEXT_TOOLS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'echo', 'printf', 'cat', 'head', 'tail', 'wc', 'ls', 'cd', 'man', 'which', 'type', 'test', 'stat', 'du', 'diff']);
/**
 * Whether one segment runs an AWS CLI call that may change state. When `aws` is the command run (after env assignments and
 * wrappers) only a read operation passes: describe, list, get, head, batch-get, search, lookup, query, scan, select, check, validate,
 * simulate, estimate, filter, tail and wait; every `sts` call; `s3 ls` and `s3 presign`; an `s3 cp` or `s3 sync` that only downloads
 * (one `s3://` operand, first) and does not delete. Anything not on that list, or not understood, is a write. When `aws` is passed
 * to another command (`bash -c "aws …"`, `xargs aws …`) the operation must not look like a write, because that command's own
 * words may be anything. After a text tool (grep, echo, cat, ls, cd) `aws` is only a word.
 */
export function awsWrites(tokens) {
    const word = commandWord(tokens);
    if (word !== undefined && base(word) === 'aws') return awsCall(tokens, tokens.indexOf(word), true);
    if (AWS_TEXT_TOOLS.has(base(word ?? ''))) return false;
    // Every `aws` word counts, not just the first: `xargs echo aws aws s3 rm`.
    return tokens.some((t, i) => (t === 'aws' || t.endsWith('/aws')) && awsCall(tokens, i, false));
}
/** One `aws` word at `start` in the segment: whether the call after it may change state. `direct`: it is the command run. */
function awsCall(tokens, start, direct) {
    const rest = tokens.slice(start + 1);
    // Global options come before the service; the first two other words are the service and the operation.
    const words = [];
    for (let i = 0; i < rest.length; i += 1) {
        if (rest[i].startsWith('-')) {
            if (words.length < 2 && AWS_VALUE_OPTIONS.has(rest[i])) i += 1;
            else if (words.length >= 2) words.push(rest[i]);
            continue;
        }
        words.push(rest[i]);
    }
    const [service, op] = words;
    if (!direct) {
        if (op === undefined) return false;
        if (service === 's3') return ['rm', 'mv', 'rb', 'mb'].includes(op) || (['cp', 'sync'].includes(op) && words.slice(2).some(w => w.startsWith('s3://') || w.startsWith('--delete')));
        // A write-looking operation of any service, or any operation that is not a read on a service named here. A bare word "aws" in
        // a PR body ("aws account migration") names no service, so it is not read as a command.
        return AWS_WRITE_OP.test(op) || (AWS_SERVICES.has(service) && !AWS_READ_OP.test(op));
    }
    if (service === undefined || service === 'help' || rest.includes('--version') || rest.includes('--help')) return false;
    if (service === 'sts') return false;
    if (service === 'configure') return !['list', 'get', 'list-profiles'].includes(op);
    if (service === 'sso') return !(op === 'login' || op === 'logout' || AWS_READ_OP.test(op ?? ''));
    if (service === 's3') {
        if (op === 'ls' || op === 'presign') return false;
        if (op === 'cp' || op === 'sync') {
            // A bare `-` is stdin or stdout, an operand: `aws s3 cp - s3://b/k` uploads.
            const operands = words.slice(2).filter(w => w === '-' || !w.startsWith('-'));
            const remote = operands.filter(w => w.startsWith('s3://'));
            if (words.slice(2).some(w => w.startsWith('--delete'))) return true;
            return remote.length > 1 || (remote.length === 1 && operands[0] !== remote[0]);
        }
        return true;
    }
    return op === undefined || !AWS_READ_OP.test(op);
}
// zsh runs `=rm` as rm, and macOS file names ignore case (`Rm` is /bin/rm), so both are folded away.
const base = token => token.split('/').pop().replace(/^=+/, '').toLowerCase();
/**
 * The command word of a segment: the first token after env assignments and any run of wrappers in any order (`command`, `exec`, `env`,
 * `nohup`, `time`, `sudo`, `nice`, `timeout`, ...), skipping the wrappers' own options (`time -p`, `env -i`, `exec -a name`, `sudo -u x`).
 */
const commandWord = tokens => tokens[commandIndex(tokens)];
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
    { name: 'aws write', test: tokens => awsWrites(tokens) },
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

/** Load the persisted log and the saved on/off choice. Missing or malformed values fall back to an empty log, and
 *  Auto approve is on (no end time) unless the user's saved choice is exactly off. */
export async function load(store, now = Date.now(), mono = performance.now()) {
    try {
        const raw = await store.api.storage.get(LOG_KEY);
        store.auto.log = (Array.isArray(raw) ? raw : []).filter(validEntry).slice(-LOG_CAP);
    } catch { store.auto.log = []; }
    let saved = null;
    try { saved = await store.api.storage.get(ENABLED_KEY); } catch { /* unreadable: the default, on */ }
    if (saved !== false) turnOn(store, null, now, mono);
}

/** Remember the user's choice across a reload. A failed write leaves the choice in memory only. */
export async function saveEnabled(store, enabled) {
    try { await store.api.storage.set(ENABLED_KEY, enabled); } catch { /* the choice still lives in memory */ }
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
 * Turn on for `hours` (default: no end time; null or 0 also mean until turned off). Counters, the rate guard and the
 * tried set restart. Already-open recognised cards are approved on the next run.
 */
export function turnOn(store, hours, now = Date.now(), mono = performance.now()) {
    let endAt = null;
    if (hours === undefined || hours === null || hours === 0) endAt = null;
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

// The floor policy, the user's choice on 14 Nov (swarm-it-herdr/lib/policy.mjs has the same): everything is answered except terraform
// apply or destroy and AWS writes. Besides those two rules, a command whose real words the shell only builds at run time stays left,
// because it could spell either of them.
export const FLOOR_RULES = new Set(['terraform apply or destroy', 'aws write', 'command word is a variable', 'alias or eval', 'shell expansion builds a word',
    'shell fed generated code', 'command word from a substitution', 'ANSI-C escape', 'env -S', 'git -c alias', 'git config from the environment']);

/** Which policy answers: `floor` (the default) or `careful`, the full never list and Kelpi's example policy. Set SWARM_AUTO_APPROVE_POLICY=careful for the old behaviour. */
export const POLICY_ENV = 'SWARM_AUTO_APPROVE_POLICY';
export const approvePolicy = (env = process.env) => (String(env[POLICY_ENV] ?? '').trim().toLowerCase() === 'careful' ? 'careful' : 'floor');

/**
 * Agent settings files stay with the user under the floor too (agreed 24 Nov), so an agent cannot change its own permission
 * rules: Claude and Codex settings and config, ~/.claude.json, .mcp.json and the hooks folders that run on every command.
 * Narrower than Kelpi's `agent settings write`, which covers all of ~/.claude (memory, skills, plans).
 */
export const FLOOR_SETTINGS_RULE = 'agent settings write';
const FLOOR_SETTINGS = /\.claude[^/\s'"]*\/(?:settings[^/\s'"]*\.json|hooks(?:\/|$|['"\s]))|\.claude\.json|\.codex\/(?:config\.toml|rules\/|hooks)|\.mcp\.json|claude_config_dir|codex_home/i;
/**
 * A shell command is read more widely and fails closed: a word naming a .claude, .codex or .mcp.json path in any case (so a
 * `cd` there, a glob, a `..`, `ln` or `cp` into it all count) leaves the command, unless the command only reads, or the word
 * is the script being run (`~/.claude/skills/x/run`, `node ~/.claude/skills/x.mjs`). Running a script is not writing it.
 */
const SETTINGS_MENTION = /\.claude|\.codex|\.mcp\.json|claude_config_dir|codex_home/i;
/** A hidden path part spelled with a glob or brace (`~/.cl*de`, `~/.{claude,x}`, `~/[.]claude`): it could be any of them. */
const HIDDEN_PATTERN = /(?:^|\/)(?:\.[^/]*[*?[{]|\[)/;
/** A word that is just `[` or `[[` is the shell's test command (`[ -f x ]`), not a glob; `[` starting a longer path part still is. */
const mentions = word => SETTINGS_MENTION.test(word) || (word !== '[' && word !== '[[' && HIDDEN_PATTERN.test(word));
/** A redirection into one of those paths, read on the raw text so no tokenizing can split it off: `>| ~/.claude/x`. */
const SETTINGS_REDIRECT = /[<>]\s*[|&]?\s*["']?[^\s;|&()]*(?:\.claude|\.codex|\.mcp\.json|\.[^/\s]*[*?[{])/i;
const SETTINGS_READERS = new Set(['cat', 'ls', 'grep', 'jq', 'head', 'tail', 'wc', 'diff', 'stat', 'file']);
const SCRIPT_RUNNERS = new Set(['node', 'bash', 'sh', 'zsh', 'python', 'python3']);
/** Only a skill's or a bin folder's script is exempt as the thing being run, and never one that is itself a settings path. */
const SCRIPT_HOME = /^(?:~|\$HOME|\$\{HOME\}|\/[^=\s$`]*)\/\.claude\/(?:(?:skills|bin|hooks)\/[^=*?[{\s$`]+\.(?:sh|mjs|js|py)|(?:skills|bin)\/[^=*?[{.\s$`]+)$/i;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const wordBase = word => String(word ?? '').split('/').pop();
function settingsWrite(tokens) {
    // `X=… cmd`: an assignment is not the command being run, so nothing in it is exempt.
    if (ASSIGNMENT.test(String(tokens[0] ?? ''))) return tokens.some(mentions);
    const runner = SCRIPT_RUNNERS.has(wordBase(tokens[0])) && !String(tokens[1] ?? '').startsWith('-');
    const exempt = i => {
        const word = String(tokens[i]);
        return (i === 0 || (i === 1 && runner)) && SCRIPT_HOME.test(word) && !word.split('/').some(s => s === '.' || s === '..');
    };
    if (!tokens.some((x, i) => !exempt(i) && mentions(x))) return false;
    const reads = SETTINGS_READERS.has(wordBase(tokens[0])) && !tokens.some(x => /[<>]/.test(x));
    return !reads;
}
/** A path that names an agent settings file, in any case. */
export const settingsPath = path => typeof path === 'string' && FLOOR_SETTINGS.test(path);

/** The settings half of the floor: the rule when the text writes, or mentions in a way that could write, an agent settings file. */
function settingsRule(command) {
    // Read before quotes are made inert: a quoted path to a settings file is still that file.
    const raw = command.replace(/\\\r?\n/g, '');
    if (SETTINGS_REDIRECT.test(raw)) return FLOOR_SETTINGS_RULE;
    for (const text of [raw, raw.split('\n').map(l => l.trim()).join(' ')]) {
        for (const tokens of segments(text)) if (settingsWrite(tokens)) return FLOOR_SETTINGS_RULE;
    }
    return null;
}

/**
 * The floor rule a command breaks, or null. Reads each line of a wrapped command the way neverAutoApprove does. `shell` is false for
 * the one line an MCP call is flattened into, which is not a shell command line: only the token rules read it.
 */
export function floorRule(command, shell = true) {
    if (typeof command !== 'string' || !command) return null;
    const settings = settingsRule(command);
    if (settings) return settings;
    // Quoted grep patterns and commit messages hold text, not commands; so do quoted heredoc bodies written by cat or tee.
    const { text: heredocFree, written } = stripHeredocs(command);
    // Unless the same command also runs a file: `cat > p.sh <<'EOF' … EOF` then `bash p.sh` runs what was written, so each body is read as
    // a shell script of its own (without its `#!` line, which would read as a command word `bash`). Plain storage stays approved.
    // A body is read as shell whatever language it is in: that can only leave more for the user, never less.
    if (shell && written.length > 0 && runsFile(heredocFree, written.flatMap(w => w.targets))) {
        for (const { body } of written) {
            const rule = floorRule(body.replace(/^#!.*(?:\n|$)/, ''), true);
            if (rule) return rule;
        }
    }
    command = inertCurlBodies(quietGrepPatterns(inertQuoted(heredocFree)));
    const joined = command.replace(/\\\r?\n/g, '');
    const lines = joined.split('\n').map(l => l.trim());
    for (const text of [joined, lines.join(' '), lines.join('')]) {
        for (const tokens of segments(text)) {
            const rule = NEVER_AUTO_APPROVE.find(r => FLOOR_RULES.has(r.name) && r.test(tokens, text));
            if (rule) return rule.name;
        }
    }
    // The rules above read quote-stripped tokens. These read the command as a shell splits it (quotes kept, redirections taken off,
    // wrappers looked through), which is how a hidden aws, terraform, terragrunt or tofu call is told from a word; and Kelpi's own
    // rules for code fed to a shell or interpreter and for `kelpi install-hooks`.
    return shell ? floorExecRule(heredocFree.replace(/\\\r?\n/g, '')) ?? kelpiFloorRule(joined) : null;
}

/**
 * The floor's answer for the text of one command: `{ rule }` when it breaks a rule, `{ tooLong: true }` when the loops in it unroll
 * past MAX_REQUEST_TEXT (the rules would read it for longer than Kelpi waits), or null. A loop is read as the commands it runs.
 */
export function floorCheck(text, shell = true) {
    const rule = floorRule(text, shell);
    if (rule) return { rule };
    const unrolled = unrollLoops(text);
    if (unrolled === text) return null;
    if (unrolled.length > MAX_REQUEST_TEXT) return { tooLong: true };
    const unrolledRule = floorRule(unrolled, shell);
    return unrolledRule ? { rule: unrolledRule } : null;
}

/** The floor policy: every Bash, Monitor, file and MCP request is answered unless it breaks a floor rule. */
export function judgeFloor(toolName, toolInput) {
    const input = toolInput !== null && typeof toolInput === 'object' && !Array.isArray(toolInput) ? toolInput : null;
    const mcp = typeof toolName === 'string' && /^mcp__./.test(toolName);
    const field = FLOOR_TOOLS.get(toolName);
    if (!input || (!field && !mcp)) return { allow: false, text: '', reason: `auto-approve does not answer ${typeof toolName === 'string' ? toolName : 'this'} requests`, code: 'TOOL' };
    const text = mcp ? `${toolName}(${strings(input).join(' ')})` : input[field];
    if (typeof text !== 'string' || !text.trim()) return { allow: false, text: '', reason: `no ${field}`, code: 'NO_INPUT' };
    if (text.length > MAX_REQUEST_TEXT) return { allow: false, text, reason: 'too long to check', code: 'TOO_LONG' };
    if (toolName === 'Bash' || toolName === 'Monitor' || mcp) {
        const check = floorCheck(text, !mcp) ?? (mcp ? mcpFloor(toolName, input) : null);
        if (check?.tooLong) return { allow: false, text, reason: 'too long to check', code: 'TOO_LONG' };
        if (check) return { allow: false, text, reason: NEVER_REASON, code: 'NEVER', rule: check.rule };
    }
    if (WRITES.has(toolName) && settingsPath(input.file_path)) return { allow: false, text, reason: NEVER_REASON, code: 'NEVER', rule: FLOOR_SETTINGS_RULE };
    return { allow: true, text };
}

/** Words beyond MCP_CHANGE_WORDS that say a tool puts something in a file. */
const FILE_WRITE_WORDS = new Set(['append', 'replace', 'overwrite', 'mkdir', 'touch', 'link', 'symlink', 'truncate', 'store', 'persist', 'dump', 'export',
    'sync', 'rewrite', 'change', 'open', 'new', 'make', 'generate', 'output', 'write']);
/** A field that says where a file is: `path`, `file_path`, `filePath`, `filename`, `destination`, `target`, `dir`, `output`, `uri`. */
const PATH_FIELD = /(?:path|file|filename|dest|destination|target|dir|directory|folder|output|out|location|uri)s?$/i;
/** A field that holds a command line to run: read as shell, not as data. */
const COMMAND_FIELD = /^(?:command|commands|cmd|commandline|command_line|cmdline|script|scripts|shell|bash|sh|exec|execute)$/i;
/** Every string value in a tool's input with whether its key says it is a command line, however deep. */
function stringEntries(value, out = [], command = false) {
    if (typeof value === 'string') out.push({ value, command });
    else if (value !== null && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) stringEntries(inner, out, Array.isArray(value) ? command : COMMAND_FIELD.test(key));
    }
    return out;
}
/** The strings held under a path-like key, however deep: `{ args: { filePath: '…' } }`, `{ paths: ['…'] }`. */
function pathValues(value) {
    return pathEntries(value).map(entry => entry.value);
}
/** The same strings with the key each sits under (an array keeps its parent's key): `{ value, key }`. */
function pathEntries(value, out = [], key = '', named = false) {
    if (typeof value === 'string') { if (named) out.push({ value, key }); } else if (value !== null && typeof value === 'object') {
        for (const [inner, item] of Object.entries(value)) pathEntries(item, out, Array.isArray(value) ? key : inner, Array.isArray(value) ? named : PATH_FIELD.test(inner));
    }
    return out;
}
/** A key that is plainly a file or folder on this machine (`path`, `filePath`, `destination`, `dest_path`), whatever its value looks like; `target` or `folder` may be a branch or a label. */
const STRONG_PATH_KEY = /^(?:path|file|filename|filepath|dest|destpath|destination|destinationpath|targetpath|outputpath|outpath)s?$/;
/** Whether an MCP tool's name plainly only reads: a reading word and no word that changes or writes anything. */
function plainlyReads(toolName) {
    const words = mcpWords(String(toolName).split('__').pop());
    return words.some(w => MCP_READ_WORDS.has(w)) && !words.some(w => MCP_CHANGE_WORDS.has(w) || FILE_WRITE_WORDS.has(w));
}
/** A field that names the program of a structured call, and one that holds its arguments (an array of words, not a command line). */
const EXEC_FIELD = /^(?:executable|exe|command|cmd|program|binary|bin|command_?name)$/i;
const ARGS_FIELD = /^(?:args|arguments|argv)$/i;
/** Beside a field that names a program, these hold arguments too; alone they are ordinary data (`options` of a Slack poll). */
const MORE_ARGS_FIELD = /^(?:params|parameters|options|opts|flags)$/i;
export const UNREADABLE_EXEC_RULE = 'structured command the floor cannot read';
const isWords = value => Array.isArray(value) && value.every(item => typeof item === 'string' || typeof item === 'number');
/** One word of a command line, single-quoted unless it is plainly safe, so the reader sees it as the one word a structured call passes. */
const shellWord = text => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`);
/**
 * An MCP call that runs a program is often written as an executable field and an `args` array (`{ executable: 'aws', args: ['s3', 'rm', …] }`),
 * which no single string holds. Each such object is joined into the one command line it stands for and judged as shell, so its words keep their
 * boundaries (the flattened line puts field names and array indices between them). A program given as an array of words (`command: ['aws', 's3', …]`)
 * is joined the same way. An object with an `args` array and no field that names the program, or arguments that are not plain words, is a layout
 * this cannot read: it is left, since the program could be anything.
 */
function structuredExecRule(value) {
    if (value === null || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
        for (const item of value) { const rule = structuredExecRule(item); if (rule) return rule; }
        return null;
    }
    const keys = Object.keys(value);
    // Every field that names a program and every field that holds arguments counts, not the first of each: an object may carry several.
    const execKeys = keys.filter(key => EXEC_FIELD.test(key) && (typeof value[key] === 'string' || Array.isArray(value[key])));
    if (execKeys.some(key => Array.isArray(value[key]) && !(isWords(value[key]) && value[key].length > 0))) return UNREADABLE_EXEC_RULE;
    if (execKeys.length === 0) {
        if (keys.some(key => ARGS_FIELD.test(key) && Array.isArray(value[key]))) return UNREADABLE_EXEC_RULE;
    } else {
        const argKeys = keys.filter(key => (ARGS_FIELD.test(key) || MORE_ARGS_FIELD.test(key)) && (Array.isArray(value[key]) || typeof value[key] === 'string'));
        // A lone string program is a command line the per-string check already read; only a program with arguments, or given as words, is joined.
        if (argKeys.length > 0 || execKeys.some(key => Array.isArray(value[key]))) {
            for (const execKey of execKeys) {
                for (const argKey of argKeys.length > 0 ? argKeys : [null]) {
                    const rule = joinedExecRule([value[execKey]].flat(), argKey === null ? [] : value[argKey]);
                    if (rule) return rule;
                }
            }
            // Which program gets which arguments, and in what order the tool puts them together, cannot be told: more than one of either is left.
            if (execKeys.length > 1 || argKeys.length > 1) return UNREADABLE_EXEC_RULE;
        }
    }
    for (const inner of Object.values(value)) { const rule = structuredExecRule(inner); if (rule) return rule; }
    return null;
}
/**
 * The rule that `program` (a string or words) followed by `args` (words, or one string that is part of the command line) breaks when read as
 * one shell command line. A program string with a space in it is read both as written (`aws s3 ls` may be a whole line) and as one word.
 */
function joinedExecRule(program, args) {
    if (Array.isArray(args) && !isWords(args)) return UNREADABLE_EXEC_RULE;
    const tail = typeof args === 'string' ? [args] : args.map(String).map(shellWord);
    const rest = program.slice(1).map(String).map(shellWord);
    const head = String(program[0]);
    for (const first of typeof program[0] === 'string' && /\s/.test(head) ? [head, shellWord(head)] : [shellWord(head)]) {
        const rule = floorRule([first, ...rest, ...tail].join(' '), true);
        if (rule) return rule;
    }
    return null;
}

/**
 * What an MCP call adds to the floor, read from its structured input instead of the one flattened line. The flattened line lets one
 * field fake a reader segment for another (`{"content":"; cat ","path":"~/.claude/settings.json"}` reads as a `cat`, which is
 * exempt, and `; echo ` before an `aws s3 rm` makes the `aws` a word). So each string value is checked on its own for a settings
 * path and as a command line (one that cannot be read as shell is data, not a command), and a tool that does not plainly only read
 * has the fields that say where it writes checked for a settings path, whatever the other fields hold.
 */
function mcpFloor(toolName, input) {
    for (const { value, command } of stringEntries(input)) {
        const rule = settingsRule(value) ?? floorExecRule(value, command);
        if (rule) return { rule };
    }
    const exec = structuredExecRule(input);
    if (exec) return { rule: exec };
    return !plainlyReads(toolName) && pathValues(input).some(mentions) ? { rule: FLOOR_SETTINGS_RULE } : null;
}

/**
 * The floor for one request, with a file write followed to where it lands, as judgeRequest does: an absolute path with no
 * `.` or `..`, symlinks resolved, not a second name (hard link) for another file. A write that lands on a settings file, or
 * whose landing place cannot be told, is left for the user.
 */
export async function judgeFloorRequest(toolName, toolInput, fs = PATH_FS) {
    const judged = judgeFloor(toolName, toolInput);
    if (!judged.allow) return judged;
    // A Write lands where its file_path says; an MCP tool that writes, moves or copies files lands where its path fields say.
    const targets = WRITES.has(toolName) ? [judged.text] : mcpWriteTargets(toolName, toolInput);
    if (targets.length > MAX_WRITE_TARGETS) return { allow: false, text: judged.text, reason: `writes to more than ${MAX_WRITE_TARGETS} files, too many to check`, code: 'PATH' };
    const names = WRITES.has(toolName) ? [] : landingNames(toolInput);
    for (const target of targets) {
        const refusal = await landing(target, judged.text, fs, names);
        if (refusal) return refusal;
    }
    return judged;
}

/** At most this many destinations of one MCP call are followed; the lookups of more would not finish inside Kelpi's deadline. */
const MAX_WRITE_TARGETS = 4;
/**
 * The local file or folder names an MCP tool that does not plainly only read may put something in, move or copy something to. A string under a
 * key that is plainly a file (`path`, `filePath`, `destination`, `dest_path`) is one whatever it holds, so a bare `notes` is a relative path and
 * is left; under another path-like key (`target`, `folder`, `dir`) it counts only when it reads as a place on this machine, since those may
 * hold a branch name or a label. A URL, an empty string or an id is not one. A `file://` URL is its path. Nothing for a tool that plainly
 * only reads (`read_text_file`, `list_directory`), or that is not an MCP tool.
 */
function mcpWriteTargets(toolName, input) {
    if (typeof toolName !== 'string' || !/^mcp__./.test(toolName) || plainlyReads(toolName)) return [];
    const places = [];
    for (const { value, key } of pathEntries(input)) {
        let place = value;
        if (/^file:\/\//i.test(value)) { try { place = decodeURI(value.slice(7)); } catch { place = value.slice(7); } }
        if (place.trim() === '' || /^[a-z][a-z0-9+.-]*:/i.test(place)) continue;
        const strong = STRONG_PATH_KEY.test(key.toLowerCase().replace(/[_-]/g, ''));
        if (!strong && !(/[/\\]/.test(place) || place.startsWith('~') || /\.[A-Za-z0-9]{1,8}$/.test(place))) continue;
        if (!places.includes(place)) places.push(place);
    }
    return places;
}
/**
 * Names a file put into a folder may get that make it a settings file or hook there, tried when a destination turns out to be a folder. `.claude.json`
 * and `.mcp.json` are not here: they are settings files in any folder, so they would leave every folder, and the source's own name already covers them.
 */
const SETTINGS_NAMES = ['settings.json', 'settings.local.json', 'hooks', 'config.toml', 'rules'];
/** The last part of every string in a tool's input: a move or copy into a folder lands under one of these names. */
const landingNames = input => [...new Set([...SETTINGS_NAMES, ...stringEntries(input).map(entry => posix.basename(entry.value.replace(/\/+$/, '')))].filter(Boolean))];
/**
 * Where one write lands: null when it is fine, or the refusal for an absolute-path, `.`/`..`, symlink, settings-file or hard-link problem.
 * `text` is what the prompt shows. `names`, for an MCP move or copy, are the names the file may take when the destination is a folder.
 */
async function landing(path, text, fs, names = []) {
    if (!path.startsWith('/')) return { allow: false, text, reason: 'not an absolute path', code: 'PATH' };
    if (path.split('/').some(s => s === '.' || s === '..')) return { allow: false, text, reason: 'a path with . or .. in it', code: 'PATH' };
    const landed = await realPath(path, fs);
    if (!landed.path) return { allow: false, text, reason: landed.reason, code: landed.code };
    if (settingsPath(landed.path)) return { allow: false, text, reason: NEVER_REASON, code: 'NEVER', rule: FLOOR_SETTINGS_RULE };
    if (typeof fs.stat === 'function') {
        try {
            const found = await lookup(fs.stat, landed.path, performance.now() + PATH_CHECK_MS);
            const folder = typeof found.isDirectory === 'function' && found.isDirectory();
            // Into a folder, a move or copy keeps the source's name: `mv x ~/.claude` lands on `~/.claude/x`.
            if (folder && names.some(name => settingsPath(posix.join(landed.path, name)))) return { allow: false, text, reason: NEVER_REASON, code: 'NEVER', rule: FLOOR_SETTINGS_RULE };
            // A folder's link count is its sub-folders and the two entries every folder has, not a second name.
            if (found.nlink > 1 && !folder) return { allow: false, text, reason: 'writes to a file with more than one name (hard link)', code: 'HARDLINK' };
        } catch (error) {
            if (!MISSING.has(error.code)) return { allow: false, text, reason: `could not tell where it writes (${error.code ?? message(error)})`, code: 'PATH' };
        }
    }
    return null;
}

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
        if (store.panes.get(item.paneID)?.agent === 'codex') continue;
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
        // Both never lists, as the provider applies: the screen fallback must not be the weaker path.
        // The same policy as the provider: the floor rules by default, both full lists under SWARM_AUTO_APPROVE_POLICY=careful.
        const never = approvePolicy() === 'floor'
            ? floorCheck(item.command ?? '')
            : (rule => (rule ? { rule } : null))(neverAutoApprove(item.command ?? '') ?? kelpiNever(item.command ?? ''));
        if (never) {
            if (!a.seenNever.has(item.id)) {
                a.seenNever.add(item.id); a.skipped += 1; changed = true;
                await appendLog(store, {
                    at: iso(now), ...describePane(store, item.paneID), paneID: item.paneID, command: item.command ?? '', ok: false, skipped: true, source: 'screen',
                    ...(never.tooLong ? { reason: 'too long to check', code: 'TOO_LONG' } : { reason: NEVER_REASON, rule: never.rule, code: 'NEVER' })
                });
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
/** The floor policy also answers Monitor, whose prompt shows the command. */
const FLOOR_TOOLS = new Map([...SCREEN_TOOLS, ['Monitor', 'command']]);
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
const PATH_FS = { realpath, lstat, stat };
/** The words of an MCP tool name (its last `__` part): `slack_send_message`, `sendMessage` and `notion-search` all split. */
export const mcpWords = name => String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/** Any of these words leaves the call for the user: `write_file`, `sendMessage`, `cancel_build`. */
export const MCP_CHANGE_WORDS = new Set(['write', 'edit', 'create', 'delete', 'remove', 'exec', 'execute', 'run', 'shell', 'send', 'post', 'update',
    'move', 'upload', 'put', 'set', 'save', 'apply', 'merge', 'cancel', 'trash', 'share', 'forward', 'reply', 'publish', 'deploy', 'unblock',
    'retry', 'rebuild', 'restart', 'stop', 'kill', 'install', 'add', 'insert', 'patch', 'modify', 'rename', 'copy', 'import', 'submit',
    'approve', 'resolve', 'mark', 'label', 'archive', 'restore', 'complete', 'respond', 'invite', 'schedule', 'pause', 'resume', 'spawn', 'download']);
/** One of these words is needed for the call to be answered at all: `get_issue`, `slack_read_channel`, `search_logs`. */
export const MCP_READ_WORDS = new Set(['get', 'list', 'read', 'search', 'query', 'fetch', 'find', 'describe', 'view', 'show', 'lookup', 'count',
    'aggregate', 'analyze', 'load', 'tail', 'whoami']);
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
    if (mcp) {
        // Deny by default: only a tool whose name says it reads is answered; one that writes, sends or runs is the user's.
        const words = mcpWords(toolName.split('__').pop());
        if (words.some(w => MCP_CHANGE_WORDS.has(w))) return { allow: false, text, reason: 'an MCP tool that changes something', code: 'MCP_CHANGES' };
        if (!words.some(w => MCP_READ_WORDS.has(w))) return { allow: false, text, reason: 'an MCP tool whose name does not say it only reads', code: 'MCP_UNKNOWN' };
        for (const part of [text, ...parts]) {
            const rule = kelpiNever(part);
            if (rule) return { allow: false, text, reason: NEVER_REASON, code: 'NEVER', rule };
        }
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
        // `..` after a symlink climbs from the link's target, so it is never resolved as text: such a path waits.
        if (text.split('/').some(s => s === '.' || s === '..')) return configWrite(text, [text, text.toLowerCase()]) ?? { allow: false, text, reason: 'a path with . or .. in it', code: 'PATH' };
        const landed = await realPath(text, fs);
        if (!landed.path) return { allow: false, text, reason: landed.reason, code: landed.code };
        const real = landed.path;
        // A hard link has no symlink to follow: a second name for ~/.claude/settings.json looks like any file.
        if (typeof fs.stat === 'function') {
            try {
                if ((await lookup(fs.stat, real, performance.now() + PATH_CHECK_MS)).nlink > 1) return { allow: false, text, reason: 'writes to a file with more than one name (hard link)', code: 'HARDLINK' };
            } catch (error) {
                if (!MISSING.has(error.code)) return { allow: false, text, reason: `could not tell where it writes (${error.code ?? message(error)})`, code: 'PATH' };
            }
        }
        const left = configWrite(text, [text, ...new Set([text.toLowerCase(), real.toLowerCase(), real])]);
        if (left) return left;
    }
    return { allow: true, text };
}

/** A write to agent, git or shell config, by any of `paths`: the abstain, or null. */
function configWrite(text, paths) {
    const settings = KELPI_NEVER.find(r => r.name === 'agent settings write');
    if (paths.some(p => settings.test([p], p))) return { allow: false, text, reason: NEVER_REASON, code: 'NEVER', rule: settings.name };
    const rule = WRITE_NEVER.find(r => paths.some(p => r.test(p.toLowerCase())));
    return rule ? { allow: false, text, reason: NEVER_REASON, code: 'NEVER', rule: rule.name } : null;
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
        const judged = approvePolicy() === 'floor' ? await judgeFloorRequest(args.toolName, args.toolInput, a.fs) : await judgeRequest(args.toolName, args.toolInput, a.fs);
        // Turned off while a path was being looked up: off means abstain, unlogged.
        if (!a.on) return ABSTAIN;
        text = judged.text;
        // Kelpi only asks the selected provider, but until checkProvider confirms it, the screen path is the one answering.
        if (!a.provider.active) { entry({ ok: false, reason: 'swarm-it is not confirmed as the active provider yet; the screen path answers', code: 'NOT_ACTIVE' }); return ABSTAIN; }
        if (args.agent !== 'claude' && args.agent !== 'codex') return leave('unknown agent', 'AGENT');
        const pane = store.panes.get(paneID);
        const other = otherSwarmPane(store, paneID);
        const recordedWorker = actionableWorker(store, paneID) ?? (other?.role === 'worker' ? other.swarm.workers.find(w => w.paneID === paneID) : null);
        // Kelpi can leave agent blank for an active Codex TUI. In that case require a live, owned Codex worker
        // whose result has not landed; an explicitly different agent or an unknown pane never qualifies.
        const codexPane = pane?.agent === 'codex' || (pane && !pane.agent && (pane.type ?? 'shell') === 'shell'
            && recordedWorker?.agent === 'codex' && store.resultExists.get(paneID) !== true);
        if (args.agent === 'codex' && (args.toolName !== 'Bash' || !codexPane)) {
            return leave('Codex request is not a verified Bash pane', 'AGENT');
        }
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
