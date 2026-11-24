// Round 3 of the review of the floor policy (24 Nov 2026), plus the user's choices of that day: a timed window that survives a reload,
// `atlantis apply`, a script written and run later, the AWS read list, interpreter argument lists, the guard on FLOOR_RULES, the screen
// path, AWS deploys without the aws CLI, Terraform state commands, MCP tools that send, share or delete, and the policy in the log.
// A test here asserts the exact decision, the code and the rule, so a command left for a different reason fails it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSwarmApi } from './backend-fake-api.mjs';

process.env.SWARM_PROMPT_SCAN_MS = '20';
process.env.SWARM_SWARMS_RELOAD_MS = '10';
process.env.SWARM_NOT_ASKED_GRACE_MS = '60';
process.env.SWARM_AUTO_RATE_MAX = '1000';
process.env.SWARM_PROVIDER_CHECK_MS = '600000';
delete process.env.SWARM_AUTO_APPROVE_POLICY;
const { registerAll } = await import('../backend/index.mjs');
const AA = await import('../backend/autoapprove.mjs');

const SELECTED = { selected: 'local.swarm-view.permissions' };
const ALLOW = { behavior: 'allow' };
const ABSTAIN = { behavior: 'abstain' };
const request = (toolName, toolInput, extra = {}) => ({ paneID: 'w1', workspaceID: 'ws1', agent: 'claude', toolName, toolInput, ...extra });
const bash = (command, input = {}) => request('Bash', { command, description: 'd', ...input });
const TERRAFORM = 'terraform apply or destroy';
const AWS = 'aws write';

async function start(extra = {}) {
    const api = makeSwarmApi({ permissions: SELECTED, ...extra });
    const dispose = registerAll(api);
    await dispose.ready;
    if (!extra.storage) await api.command('auto-approve', { on: true });
    return { api, dispose };
}
async function judge(api, args) {
    const decision = await api.decide(args);
    await api.idle();
    const entry = (await api.command('auto-approve-log', {})).entries[0];
    return [decision, entry.ok ? 'OK' : entry.code, entry.rule, entry.reason];
}
const left = (rule, code = 'NEVER', reason = AA.NEVER_REASON) => [ABSTAIN, code, rule, reason];
const approved = [ALLOW, 'OK', undefined, undefined];
/** Every command is left with its rule, or approved, and the failing command is named. */
async function expectAll(commands, expected, make = bash) {
    const { api, dispose } = await start();
    try {
        for (const [command, rule] of commands) assert.deepEqual(await judge(api, make(command)), expected(rule), typeof command === 'string' ? command : JSON.stringify(command));
    } finally { dispose(); }
}
const leftBy = (commands, make) => expectAll(commands, left, make);
const approve = (commands, make) => expectAll(commands.map(c => [c]), () => approved, make);

/** A store with just what `load` reads, so a reload at a chosen time needs no clock. */
const storeWith = saved => ({ api: { storage: { get: async key => (saved.has(key) ? saved.get(key) : null), set: async (key, value) => void saved.set(key, value) } }, auto: AA.createState() });
const HOUR = 3600000;

test('finding 1: a timed window saved with the choice is kept across a reload, and an expired one stays off', async () => {
    const now = Date.parse('2026-11-24T20:00:00.000Z');
    const mono = 5000;
    // During the window: on again, with the time that is left, not "until turned off".
    const during = storeWith(new Map([['autoApproveEnabled', true], ['autoApproveUntil', new Date(now + 3 * HOUR).toISOString()]]));
    await AA.load(during, now, mono);
    assert.deepEqual([during.auto.on, during.auto.until, during.auto.deadline], [true, new Date(now + 3 * HOUR).toISOString(), mono + 3 * HOUR]);
    assert.equal(AA.expireIfDue(during, now + 3 * HOUR + 1000, mono + 3 * HOUR + 1000), true, 'the restored window still expires');
    assert.equal(during.auto.ended.reason, 'expired');
    // After the window: off, with the reason shown, and nothing turns it back on.
    const after = storeWith(new Map([['autoApproveEnabled', true], ['autoApproveUntil', new Date(now - 60000).toISOString()]]));
    await AA.load(after, now, mono);
    assert.deepEqual([after.auto.on, after.auto.until, after.auto.ended?.reason, after.auto.ended?.at], [false, null, 'expired', new Date(now - 60000).toISOString()]);
    // A saved off wins over a saved time, and no time means on with no end, as before.
    const off = storeWith(new Map([['autoApproveEnabled', false], ['autoApproveUntil', new Date(now + HOUR).toISOString()]]));
    await AA.load(off, now, mono);
    assert.equal(off.auto.on, false);
    const bare = storeWith(new Map([['autoApproveEnabled', true], ['autoApproveUntil', null]]));
    await AA.load(bare, now, mono);
    assert.deepEqual([bare.auto.on, bare.auto.until], [true, null]);
    const old = storeWith(new Map([['autoApproveEnabled', true]]));
    await AA.load(old, now, mono);
    assert.deepEqual([old.auto.on, old.auto.until], [true, null], 'a choice saved before end times existed');
    // A garbage time is no time; one further off than a window can be is cut to the longest window.
    const junk = storeWith(new Map([['autoApproveEnabled', true], ['autoApproveUntil', 'soon']]));
    await AA.load(junk, now, mono);
    assert.deepEqual([junk.auto.on, junk.auto.until], [true, null]);
    const far = storeWith(new Map([['autoApproveEnabled', true], ['autoApproveUntil', new Date(now + 900 * HOUR).toISOString()]]));
    await AA.load(far, now, mono);
    assert.deepEqual([far.auto.on, far.auto.until], [true, new Date(now + AA.MAX_HOURS * HOUR).toISOString()]);
});

test('finding 1: the real choice and end time are saved by the command, and a reload during and after the window follows them', async () => {
    const storage = new Map();
    const first = await start({ storage });
    const timed = await first.api.command('auto-approve', { on: true, hours: 4 });
    assert.equal(storage.get('autoApproveEnabled'), true);
    assert.equal(storage.get('autoApproveUntil'), timed.autoApprove.until, 'the end time is saved with the choice');
    first.dispose();
    // A reload during the window keeps the end time.
    const during = await start({ storage });
    const state = (await during.api.command('get-state', {})).snapshot.autoApprove;
    assert.deepEqual([state.on, state.until], [true, timed.autoApprove.until]);
    // Turning on with no hours clears it; turning off clears it too and stays off.
    assert.equal((await during.api.command('auto-approve', { on: true })).autoApprove.until, null);
    assert.equal(storage.get('autoApproveUntil'), null);
    await during.api.command('auto-approve', { on: true, hours: 1 });
    await during.api.command('auto-approve', { on: false });
    assert.deepEqual([storage.get('autoApproveEnabled'), storage.get('autoApproveUntil')], [false, null]);
    during.dispose();
    // A window that ended while Kelpi was closed: the saved end is in the past, so the next start is off.
    storage.set('autoApproveEnabled', true);
    storage.set('autoApproveUntil', new Date(Date.now() - 1000).toISOString());
    const after = await start({ storage });
    const ended = (await after.api.command('get-state', {})).snapshot.autoApprove;
    assert.deepEqual([ended.on, ended.until, ended.ended?.reason], [false, null, 'expired']);
    after.dispose();
});
