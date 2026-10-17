// Auto-approve as Kelpi's kelpi.agent.permissions provider: `decide` answers from the real tool input while the window is
// on and swarm-it is the active provider; otherwise it abstains and the screen path (or the user) answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSwarmApi } from './backend-fake-api.mjs';
import { NEVER_HITS, SAFE_BASIC, NEVER_A2, SAFE_A2, NEVER_EXPANSION, SAFE_EXPANSION } from './fixtures/never-commands.mjs';

// Set before the backend loads: these are read once.
process.env.SWARM_PROMPT_SCAN_MS = '20';
process.env.SWARM_SWARMS_RELOAD_MS = '10';
process.env.SWARM_NOT_ASKED_GRACE_MS = '60';
process.env.SWARM_AUTO_RATE_MAX = '3';
// Long, so the selection tests prove the check on every scan while auto-approve is on.
process.env.SWARM_PROVIDER_CHECK_MS = '600000';
process.env.SWARM_PATH_CHECK_MS = '50';
const { registerAll, SNAPSHOT_EVENT, COUNTS_ITEM } = await import('../backend/index.mjs');
const AA = await import('../backend/autoapprove.mjs');
const { createStore } = await import('../backend/store.mjs');

const SELECTED = { selected: 'local.swarm-view.permissions' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const lastSnapshot = api => api.emitted.filter(e => e.name === SNAPSHOT_EVENT).at(-1)?.data;
const enters = api => api.callsTo('terminal.sendKey').filter(c => c.args[1] === 'enter').length;
const prompt = cmd => ['╭──────────────────╮', ' Bash command', '', `   ${cmd}`, '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'].join('\n');
const request = (toolName, toolInput, extra = {}) => ({ paneID: 'w1', workspaceID: 'ws1', agent: 'claude', toolName, toolInput, ...extra });
const bash = (command, input = {}, extra = {}) => request('Bash', { command, description: 'd', ...input }, extra);
const ALLOW = { behavior: 'allow' };
const ABSTAIN = { behavior: 'abstain' };
const FIX = /kelpi plugin service-select kelpi\.agent\.permissions local\.swarm-view\.permissions" and "kelpi install-hooks"/;

async function start(extra = {}) {
    const api = makeSwarmApi(extra);
    const dispose = registerAll(api);
    await dispose.ready;
    return { api, dispose };
}
const logOf = async api => (await api.command('auto-approve-log', {})).entries;

/** A fresh pane id per call, so the rate guard never pauses a test that makes many decisions. */
let paneCount = 0;
const freshPane = args => ({ ...args, paneID: `p${paneCount += 1}` });

/** A bare store with the provider active and auto-approve on, for calling `decide` with chosen clocks. */
function activeStore(hours = 1, now = Date.now(), mono = performance.now()) {
    const store = createStore(makeSwarmApi());
    store.auto = AA.createState();
    store.auto.provider.registered = true;
    store.auto.provider.active = true;
    AA.turnOn(store, hours, now, mono);
    return store;
}

test('swarm-it registers its decide as the kelpi.agent.permissions provider the manifest declares', async () => {
    const { api, dispose } = await start({ permissions: SELECTED });
    assert.deepEqual(api.callsTo('providers.register').map(c => c.args), [['local.swarm-view.permissions']]);
    assert.equal(typeof api.providerMethods.get('local.swarm-view.permissions').decide, 'function');
    const manifest = JSON.parse(await readFile(new URL('../kelpi.plugin.json', import.meta.url), 'utf8'));
    assert.deepEqual(manifest.contributes.providers.map(({ id, service, version, methods }) => ({ id, service, version, methods })),
        [{ id: AA.PROVIDER_ID, service: AA.PERMISSIONS_SERVICE, version: 1, methods: ['decide'] }]);
    assert.equal(AA.SELECT_COMMAND, 'kelpi plugin service-select kelpi.agent.permissions local.swarm-view.permissions');
    dispose();
    assert.equal(api.providerMethods.size, 0, 'unregistered on dispose');
});

test('allow inside the window, abstain outside it; decisions made while on are logged with source provider', async () => {
    const { api, dispose } = await start({ permissions: SELECTED });
    assert.deepEqual(await api.decide(bash('npm test')), ABSTAIN, 'off');
    assert.deepEqual(await logOf(api), [], 'nothing is logged while off');
    await api.command('auto-approve', { on: true, hours: 1 });
    assert.equal(lastSnapshot(api).autoApprove.provider.active, true);
    assert.deepEqual(await api.decide(bash('npm test')), ALLOW);
    await api.idle();
    const [entry] = await logOf(api);
    assert.deepEqual([entry.ok, entry.source, entry.tool, entry.command, entry.paneID, entry.label, entry.swarmName], [true, 'provider', 'Bash', 'npm test', 'w1', 'repo-lag', 'Swarm']);
    assert.equal(lastSnapshot(api).autoApprove.approved, 1, 'the rail is told');
    await api.command('auto-approve', { on: false });
    assert.deepEqual(await api.decide(bash('npm test')), ABSTAIN, 'off again');
    assert.equal((await logOf(api)).length, 1);
    dispose();
});

test('a never-list command abstains: swarm-it rules first, then the Kelpi example rules, then multi-line and length', async () => {
    const { api, dispose } = await start({ permissions: SELECTED });
    await api.command('auto-approve', { on: true });
    for (const [command, code, rule] of [
        ['git push origin main', 'NEVER', 'git push'],
        // On Kelpi's list only: the union catches it.
        ['git branch -D old', 'NEVER', 'git branch -D'],
        ['kelpi plugin service-select kelpi.agent.permissions default', 'NEVER', 'kelpi plugin'],
        ['ls\nmv a b', 'MULTILINE', undefined],
        [`echo ${'a'.repeat(AA.MAX_REQUEST_TEXT)}`, 'TOO_LONG', undefined]
    ]) assert.deepEqual(await api.decide(bash(command)), ABSTAIN, command);
    await api.idle();
    const entries = (await logOf(api)).reverse();
    assert.deepEqual(entries.map(e => [e.ok, e.skipped, e.source, e.code, e.rule]), [
        [false, true, 'provider', 'NEVER', 'git push'], [false, true, 'provider', 'NEVER', 'git branch -D'], [false, true, 'provider', 'NEVER', 'kelpi plugin'],
        [false, true, 'provider', 'MULTILINE', undefined], [false, true, 'provider', 'TOO_LONG', undefined]
    ]);
    assert.equal(entries[0].reason, AA.NEVER_REASON);
    assert.equal(entries[4].command.length, 1001, 'a long command is kept to 1000 characters and an ellipsis');
    assert.equal(lastSnapshot(api).autoApprove.skipped, 5);
    assert.equal(lastSnapshot(api).autoApprove.approved, 0);
    dispose();
});

test('a Bash call that asks to run outside the sandbox abstains, whatever the command', async () => {
    const { api, dispose } = await start({ permissions: SELECTED });
    await api.command('auto-approve', { on: true });
    assert.deepEqual(await api.decide(bash('ls', { dangerouslyDisableSandbox: true })), ABSTAIN);
    assert.deepEqual(await api.decide(bash('ls', { dangerouslyDisableSandbox: false })), ALLOW);
    await api.idle();
    const [allowed, left] = await logOf(api);
    assert.deepEqual([left.ok, left.code, left.reason, left.command], [false, 'SANDBOX', 'asks to run outside the sandbox', 'ls']);
    assert.equal(allowed.ok, true);
    dispose();
});

test('when deciding throws, decide abstains and logs the error instead of failing the call', async () => {
    const { api, dispose } = await start({ permissions: SELECTED });
    await api.command('auto-approve', { on: true });
    const broken = bash('ls');
    Object.defineProperty(broken, 'toolInput', { get() { throw new Error('boom'); } });
    assert.deepEqual(await api.decide(broken), ABSTAIN);
    assert.deepEqual(await api.decide(null), ABSTAIN, 'no arguments at all');
    await api.idle();
    const entries = (await logOf(api)).reverse();
    assert.deepEqual(entries.map(e => [e.ok, e.code, e.reason, e.source, e.paneID]), [
        [false, 'ERROR', 'error: boom', 'provider', 'w1'],
        [false, 'ERROR', "error: Cannot read properties of null (reading 'toolName')", 'provider', '?']
    ]);
    assert.equal(lastSnapshot(api).autoApprove.approved, 0);
    dispose();
});

test('the window ends on whichever clock runs out first: the wall clock, or the monotonic one a clock change cannot move', async () => {
    const now = Date.now();
    const mono = performance.now();
    const hour = 3600000;
    let store = activeStore(1, now, mono);
    assert.deepEqual(await AA.decide(store, bash('ls'), now + 1000, mono + 1000), ALLOW);
    assert.deepEqual(await AA.decide(store, bash('ls'), now - 5 * hour, mono + hour), ABSTAIN, 'the monotonic deadline passed (the clock was set back)');
    assert.deepEqual([store.auto.on, store.auto.ended.reason], [false, 'expired']);
    store = activeStore(1, now, mono);
    assert.deepEqual(await AA.decide(store, bash('ls'), now + hour, mono + 1000), ABSTAIN, 'the wall-clock end passed (the Mac slept)');
    assert.deepEqual([store.auto.on, store.auto.ended.reason], [false, 'expired']);
    store = activeStore(null, now, mono);
    assert.deepEqual(await AA.decide(store, bash('ls'), now + 100 * hour, mono + 100 * hour), ALLOW, 'until turned off never expires');
});

test('an exact end time sets both clocks', async () => {
    const { api, dispose } = await start({ permissions: SELECTED });
    const until = new Date(Date.now() + 30 * 60000).toISOString();
    const before = performance.now();
    await api.command('auto-approve', { on: true, until });
    const { deadline } = dispose.store.auto;
    assert.equal(dispose.store.auto.until, until);
    assert.ok(Math.abs(deadline - (before + 30 * 60000)) < 2000, `deadline ${deadline - before} ms away`);
    dispose();
});

test('other tools keep the screen path decisions: the same tool types, the never list on what the prompt shows', async () => {
    const store = activeStore();
    const cases = [
        [request('Edit', { file_path: '/wt/w1/src/a.ts', old_string: 'a', new_string: 'b' }), 'allow'],
        [request('MultiEdit', { file_path: '/wt/w1/src/a.ts', edits: [] }), 'allow'],
        [request('Write', { file_path: '/wt/w1/new.md', content: 'x' }), 'allow'],
        [request('Read', { file_path: '/Users/me/.claude/settings.json' }), 'allow'],
        [request('WebFetch', { url: 'https://example.com', prompt: 'x' }), 'allow'],
        [request('mcp__github__get_issue', { number: 1 }), 'allow'],
        [request('Write', { file_path: '/Users/me/.claude/settings.json', content: '{}' }), 'agent settings write'],
        [request('Edit', { file_path: '/wt/w1/.claude/settings.local.json', old_string: 'a', new_string: 'b' }), 'agent settings write'],
        [request('mcp__shell__run', { cmd: 'git push origin main' }), 'git push'],
        // JSON would escape these past the never list: the raw strings are read, and a control character is refused.
        [request('mcp__shell__run', { opts: { cmd: 'git push origin' } }), 'git push'],
        [request('mcp__shell__run', { cmd: 'ls\ngit push' }), 'CONTROL'],
        [request('Write', { file_path: '/wt/w1/notes\n.md', content: 'x' }), 'CONTROL'],
        // macOS paths ignore case, and `..` is resolved before the path is read.
        [request('Edit', { file_path: '/Users/me/.Claude/Settings.json', old_string: 'a', new_string: 'b' }), 'agent settings write'],
        [request('Write', { file_path: '/Users/me/repo/../.claude/hooks/x.sh', content: 'x' }), 'agent settings write'],
        [request('Write', { file_path: '/wt/w1/.claude/hooks/x.sh', content: 'x' }), '.claude or .codex folder, or .mcp.json'],
        [request('Write', { file_path: '/wt/w1/.mcp.json', content: '{}' }), '.claude or .codex folder, or .mcp.json'],
        [request('Write', { file_path: '/wt/w1/.git/x/../config', content: 'x' }), 'git hooks or config'],
        [request('Write', { file_path: '/wt/w1/.git/hooks/pre-commit', content: 'x' }), 'git hooks or config'],
        [request('Edit', { file_path: '/wt/w1/.GIT/config', old_string: 'a', new_string: 'b' }), 'git hooks or config'],
        [request('Write', { file_path: '/wt/w1/.git/worktrees/a/config.worktree', content: 'x' }), 'git hooks or config'],
        [request('Write', { file_path: '/Users/me/.gitconfig', content: 'x' }), 'git hooks or config'],
        [request('Write', { file_path: '/Users/me/.zshrc', content: 'x' }), 'shell startup file'],
        [request('Write', { file_path: '/wt/w1/.envrc', content: 'x' }), 'shell startup file'],
        [request('Write', { file_path: '/Users/me/Library/LaunchAgents/x.plist', content: 'x' }), 'launch agent'],
        // A relative path could not be followed through its symlinks.
        [request('Write', { file_path: 'link/hooks/pre-commit', content: 'x' }), 'PATH'],
        [request('Edit', { file_path: '~/notes.md', old_string: 'a', new_string: 'b' }), 'PATH'],
        [request('Read', { file_path: 'notes.md' }), 'allow'],
        [request('Write', { file_path: '/wt/w1/.github/workflows/ci.yml', content: 'x' }), 'allow'],
        [request('Read', { file_path: '/wt/w1/.git/config' }), 'allow'],
        [request('mcp__shell__run', { opts: { 'ls\ngit push': 1 } }), 'CONTROL'],
        [request('NotebookEdit', { notebook_path: '/wt/w1/a.ipynb', new_source: 'x' }), 'TOOL'],
        [request('WebSearch', { query: 'x' }), 'TOOL'],
        [request('Edit', { old_string: 'a', new_string: 'b' }), 'NO_INPUT'],
        [request('constructor', { command: 'ls' }), 'TOOL'],
        [bash('npm test', {}, { agent: 'codex' }), 'AGENT']
    ];
    for (const [args, expected] of cases) {
        const decision = await AA.decide(store, freshPane(args));
        const entry = store.auto.log.at(-1);
        assert.equal(decision.behavior === 'allow' ? 'allow' : entry.rule ?? entry.code, expected, `${args.toolName} ${JSON.stringify(args.toolInput)}`);
    }
});

test('a write through a symlink is judged by where it lands; one through a dangling symlink waits for the user', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'swarm-perm-')));
    mkdirSync(join(root, 'repo', '.git', 'hooks'), { recursive: true });
    symlinkSync(join(root, 'repo', '.git'), join(root, 'repo', 'g'));
    symlinkSync(join(root, 'nowhere', 'x'), join(root, 'repo', 'dangling'));
    symlinkSync(join(root, 'repo', 'loop'), join(root, 'repo', 'loop'));
    const store = activeStore();
    try {
        assert.equal(await judgeWrite(store, join(root, 'repo', 'g', 'hooks', 'pre-commit')), 'git hooks or config');
        assert.equal(await judgeWrite(store, join(root, 'repo', 'dangling')), 'SYMLINK');
        assert.equal(await judgeWrite(store, join(root, 'repo', 'loop', 'x')), 'PATH', 'a symlink loop is not taken for a missing folder');
        assert.equal(await judgeWrite(store, join(root, 'repo', 'src', 'new.ts')), 'allow', 'a folder that does not exist yet is fine');
    } finally {
        rmSync(root, { recursive: true });
    }
});

/** Decide one Write and return 'allow', or the rule or code it was left with. */
async function judgeWrite(store, path) {
    const decision = await AA.decide(store, freshPane(request('Write', { file_path: path, content: 'x' })));
    return decision.behavior === 'allow' ? 'allow' : store.auto.log.at(-1).rule ?? store.auto.log.at(-1).code;
}

test('a write whose path lookup hangs or fails waits for the user, and stuck lookups stop new ones', async () => {
    const store = activeStore();
    const hung = [];
    store.auto.fs = {
        realpath: path => path === '/hang/x' ? new Promise(resolve => hung.push(() => resolve(path))) : Promise.resolve(path),
        lstat: () => Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    };
    const started = performance.now();
    assert.equal(await judgeWrite(store, '/hang/x'), 'PATH');
    assert.ok(performance.now() - started < AA.PATH_CHECK_MS + 400, 'answered once the lookup ran out of time');
    assert.equal(store.auto.log.at(-1).reason, 'could not tell where it writes (TIMEOUT)');
    assert.equal(await judgeWrite(store, '/hang/x'), 'PATH');
    assert.equal(await judgeWrite(store, '/wt/w1/a.ts'), 'PATH', 'two stuck lookups: none start');
    assert.equal(store.auto.log.at(-1).reason, 'earlier path lookups are still stuck');
    for (const finish of hung) finish();
    await sleep(0);
    assert.equal(await judgeWrite(store, '/wt/w1/a.ts'), 'allow', 'lookups start again once the stuck ones return');
    store.auto.fs.realpath = () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }));
    assert.equal(await judgeWrite(store, '/wt/w1/a.ts'), 'PATH', 'only a missing path is walked up from');
    assert.equal(store.auto.log.at(-1).reason, 'could not tell where it writes (EACCES)');
});

test('turning auto-approve off while a write path is looked up abstains without logging', async () => {
    const store = activeStore();
    let finish;
    store.auto.fs = { realpath: path => new Promise(resolve => { finish = () => resolve(path); }), lstat: () => Promise.reject(new Error('unused')) };
    const pending = AA.decide(store, freshPane(request('Write', { file_path: '/wt/w1/a.ts', content: 'x' })));
    const logged = store.auto.log.length;
    AA.turnOff(store, 'user');
    await sleep(0);
    finish();
    assert.deepEqual(await pending, ABSTAIN);
    assert.equal(store.auto.log.length, logged);
});

test('the rate guard stops a pane after the limit; its later requests abstain, other panes are still allowed', async () => {
    const { api, dispose } = await start({ permissions: SELECTED });
    await api.command('auto-approve', { on: true });
    assert.equal(AA.RATE_MAX, 3);
    const decisions = [];
    for (const c of ['echo 1', 'echo 2', 'echo 3', 'echo 4']) decisions.push((await api.decide(bash(c))).behavior);
    assert.deepEqual(decisions, ['allow', 'allow', 'allow', 'abstain']);
    assert.deepEqual(await api.decide(bash('ls', {}, { paneID: 'w2' })), ALLOW);
    await api.idle();
    const auto = lastSnapshot(api).autoApprove;
    assert.deepEqual(auto.paused.map(p => [p.paneID, p.label]), [['w1', 'repo-lag']]);
    assert.equal((await logOf(api))[1].code, 'PAUSED');
    dispose();
});

test('no Enter from the screen path while the provider is active, even for cards already open at switch-on', async () => {
    const { api, dispose } = await start({ permissions: SELECTED });
    api.captureStore.w1 = prompt('npm test');
    await sleep(60);
    await api.command('auto-approve', { on: true, hours: 1 });
    api.captureStore.orch = prompt('ls');
    api.captureStore.w2 = prompt('npm run build');
    await sleep(150);
    assert.equal(enters(api), 0, 'the screen path sends no key');
    assert.equal(dispose.store.attention.filter(i => i.type === 'Request' && !i.handledAt).length, 3, 'the cards stay for the user');
    assert.deepEqual(await api.decide(bash('npm test')), ALLOW, 'the provider is the path that answers');
    // Manual Approve from the rail still works.
    const card = dispose.store.attention.find(i => i.paneID === 'w2' && i.type === 'Request' && !i.handledAt);
    assert.deepEqual(await api.command('approve', { itemID: card.id, promptHash: card.promptHash }), { ok: true, itemID: card.id });
    assert.equal(enters(api), 1);
    dispose();
});

test('a card on a pane the provider never heard about is logged once as NOT_ASKED; a pane it decided on is not', async () => {
    const { api, dispose } = await start({ permissions: SELECTED });
    await api.command('auto-approve', { on: true });
    // w2's request reached the provider (left for the user), so its card is expected.
    assert.deepEqual(await api.decide(bash('git push', {}, { paneID: 'w2' })), ABSTAIN);
    api.captureStore.w1 = prompt('npm test');
    api.captureStore.w2 = prompt('git push');
    await sleep(250);
    const notAsked = (await logOf(api)).filter(e => e.code === 'NOT_ASKED');
    assert.deepEqual(notAsked.map(e => [e.paneID, e.source, e.ok, e.command]), [['w1', 'screen', false, 'npm test']]);
    assert.match(notAsked[0].reason, /restart Claude in this pane/);
    assert.equal(enters(api), 0);
    dispose();
});

test('fallback on an older Kelpi (no provider API): the screen path approves, and the rail and status bar say how to fix it', async () => {
    const { api, dispose } = await start();
    assert.equal(dispose.store.auto.provider.registered, false);
    assert.deepEqual(lastSnapshot(api).warnings, [], 'no warning while auto-approve is off');
    await api.command('auto-approve', { on: true });
    api.captureStore.w1 = prompt('npm test');
    await sleep(100);
    assert.equal(enters(api), 1, 'screen-based auto-approve as before');
    const snap = lastSnapshot(api);
    assert.equal(snap.autoApprove.provider.active, false);
    assert.match(snap.autoApprove.provider.warning, /cannot take permission decisions from plugins/);
    assert.match(snap.autoApprove.provider.warning, FIX);
    assert.deepEqual(snap.warnings.filter(w => w.startsWith('auto-approve: ')).length, 1, 'one line in the rail');
    assert.match(api.statusUpdates.at(-1).items[COUNTS_ITEM].tooltip, FIX);
    const [entry] = await logOf(api);
    assert.deepEqual([entry.ok, entry.source], [true, 'screen']);
    await api.command('auto-approve', { on: false });
    assert.deepEqual(lastSnapshot(api).warnings, []);
    assert.equal(api.statusUpdates.at(-1).items[COUNTS_ITEM].tooltip, 'Swarm: waiting / running / finished');
    dispose();
});

test('fallback when swarm-it is not the selected provider, the service is missing, or the check fails', async () => {
    for (const [permissions, pattern] of [
        [{ selected: null }, /not the selected permissions provider/],
        [{ selected: 'other.plugin.permissions' }, /not the selected permissions provider/],
        [{ selected: 'local.swarm-view.permissions', active: null }, /selected permissions provider but Kelpi asks none/],
        [{ missing: true }, /no kelpi\.agent\.permissions service/],
        [{ listFails: 'socket closed' }, /could not check the permissions provider \(socket closed\)/]
    ]) {
        const { api, dispose } = await start({ permissions });
        await api.command('auto-approve', { on: true });
        const warning = lastSnapshot(api).autoApprove.provider.warning;
        assert.match(warning, pattern, JSON.stringify(permissions));
        assert.match(warning, FIX);
        api.captureStore.w1 = prompt('npm test');
        await sleep(100);
        assert.equal(enters(api), 1, `the screen path answers: ${JSON.stringify(permissions)}`);
        // Kelpi asking an unconfirmed provider (a selection made a moment ago) is left to the screen path.
        assert.deepEqual(await api.decide(bash('npm test', {}, { paneID: 'w2' })), ABSTAIN);
        dispose();
    }
});

test('selecting swarm-it while auto-approve is on moves answering from the screen to the provider on the next scan', async () => {
    const { api, dispose } = await start({ permissions: { selected: null } });
    await api.command('auto-approve', { on: true });
    assert.equal(lastSnapshot(api).autoApprove.provider.active, false);
    api.permissions.selected = 'local.swarm-view.permissions';
    await sleep(80);
    assert.deepEqual(lastSnapshot(api).autoApprove.provider, { active: true, warning: null });
    assert.deepEqual(lastSnapshot(api).warnings, []);
    api.captureStore.w1 = prompt('npm test');
    await sleep(100);
    assert.equal(enters(api), 0, 'no screen Enter once the provider answers');
    // Back to the bundled default: the screen path takes over again.
    api.permissions.selected = null;
    await sleep(100);
    assert.equal(lastSnapshot(api).autoApprove.provider.active, false);
    assert.equal(enters(api), 1);
    dispose();
});

test('every existing never-list command abstains through the provider, with the same rule where one is named', async () => {
    const store = activeStore();
    const judge = async command => {
        const decision = await AA.decide(store, freshPane(bash(command)));
        return decision.behavior === 'allow' ? null : store.auto.log.at(-1).rule ?? store.auto.log.at(-1).code;
    };
    for (const [command, rule] of Object.entries(NEVER_HITS)) assert.equal(await judge(command), rule, command);
    for (const command of [...NEVER_A2, ...NEVER_EXPANSION]) assert.ok(await judge(command), command);
    // The union with Kelpi's list leaves these screen-safe commands for the user too: accepted false positives.
    const left = {};
    for (const command of [...SAFE_BASIC, ...SAFE_A2, ...SAFE_EXPANSION]) {
        const rule = await judge(command);
        if (rule) left[command] = rule;
    }
    assert.deepEqual(left, {
        'git restore --source HEAD file.ts': 'git checkout, restore or switch discarding changes',
        'node --test test/*.test.mjs': 'brace or glob expansion',
        'find . -name "*.mjs"': 'brace or glob expansion',
        'echo ${HOME}/x': 'brace or glob expansion',
        'ls ${TMPDIR}': 'brace or glob expansion',
        "awk '{print $1}' f": 'brace or glob expansion',
        'cmd1 || bash -c true': 'piped or heredoc into a shell or interpreter',
        'jq ".[] | .a" f': 'brace or glob expansion'
    });
});

test('the longest command checked is judged well inside the 2 second deadline', async () => {
    const store = activeStore();
    for (const command of ['a;'.repeat(AA.MAX_REQUEST_TEXT / 2), 'x |'.repeat(Math.floor(AA.MAX_REQUEST_TEXT / 3)), 'a&&'.repeat(Math.floor(AA.MAX_REQUEST_TEXT / 3))]) {
        const started = performance.now();
        await AA.decide(store, freshPane(bash(command)));
        const took = performance.now() - started;
        assert.ok(took < 500, `${command.slice(0, 6)}… took ${Math.round(took)} ms`);
    }
});

test('the vendored Kelpi policy is the example file unchanged', async () => {
    const text = await readFile(new URL('../backend/kelpi-policy.mjs', import.meta.url), 'utf8');
    const body = text.split('\n').slice(2).join('\n');
    assert.equal(createHash('sha256').update(body).digest('hex'), '735828ae9741c5bb82ed9635a006f01b26844d083cf8518ce20755c3ff4fce87');
});
