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

const STATE = 'terraform state change';
const DEPLOY = 'aws deploy';

test('finding 2: an atlantis apply, import or state comment is left in a command and in an MCP string, atlantis plan is not', async () => {
    await leftBy([
        ['gh pr comment 123 --body "atlantis apply"', TERRAFORM],
        ["gh pr comment 123 --body 'atlantis apply -d infra/prod'", TERRAFORM],
        ["gh pr comment 123 --body-file - <<'EOF'\natlantis apply\nEOF", TERRAFORM],
        ['gh pr comment 123 --body "Atlantis  Apply"', TERRAFORM],
        ['echo "atlantis apply" | gh pr comment 1 -F -', TERRAFORM],
        ['gh pr comment 1 -b "atlantis import aws_s3_bucket.b b"', STATE],
        ['gh pr comment 1 -b "atlantis state rm aws_s3_bucket.b"', STATE]
    ]);
    await approve([
        'gh pr comment 123 --body "atlantis plan"',
        'gh pr comment 123 --body "atlantis plan -d infra/prod"',
        'echo "the atlantis server is up"',
        'gh pr view 123'
    ]);
    const comment = body => request('mcp__github__add_issue_comment', { owner: 'o', repo: 'infrastructure', issue_number: 5, body });
    await expectAll([[{ body: 'atlantis apply' }, TERRAFORM], [{ body: 'ok\natlantis apply -p prod' }, TERRAFORM], [{ body: 'atlantis import a b' }, STATE]],
        rule => left(rule), input => comment(input.body));
    await expectAll([[{ body: 'atlantis plan' }], [{ body: 'looks good' }]], () => approved, input => comment(input.body));
});

test('finding 6: code handed to an interpreter that spells aws, terraform, terragrunt or tofu out as a string is left', async () => {
    await leftBy([
        [`node -e "require('child_process').spawnSync('terraform', ['apply','-auto-approve'])"`, TERRAFORM],
        [`node -e 'execFileSync("/usr/local/bin/terraform", ["apply"])'`, TERRAFORM],
        [`python3 -c 'import subprocess; subprocess.run(("aws","s3","rm","s3://b/k","--recursive"))'`, AWS],
        [`python3 -c 'import subprocess; subprocess.run(["terragrunt", "run-all", "apply"])'`, TERRAFORM],
        [`ruby -e 'system("tofu", "apply")'`, TERRAFORM],
        [`perl -e 'system("terraform", "destroy")'`, TERRAFORM],
        [`deno eval 'new Deno.Command("aws", {args:["s3","rm","x"]}).outputSync()'`, AWS],
        [`bun -e "Bun.spawnSync(['terraform','apply'])"`, TERRAFORM]
    ]);
    await approve([
        'node -e "console.log(1 + 1)"',
        `python3 -c 'print("hello")'`,
        'node script.js aws',
        `python3 -c 'print("terraform is a tool")'`,
        `node -e "console.log('awscli')"`
    ]);
});

test('finding 9: AWS deploys without the aws CLI are left, and so is a push to an ECR registry', async () => {
    const ecr = '123456789012.dkr.ecr.ap-southeast-2.amazonaws.com';
    await leftBy([
        ['cdk deploy', DEPLOY], ['cdk deploy --all --require-approval never', DEPLOY], ['npx cdk destroy MyStack', DEPLOY],
        ['cdk bootstrap aws://123456789012/ap-southeast-2', DEPLOY], ['cdk --profile p deploy Stack', DEPLOY], ['pnpm dlx aws-cdk@2 deploy', DEPLOY],
        ['bash -c "cdk deploy"', DEPLOY], ['cdk "$ACTION"', DEPLOY], ['echo Stack | xargs cdk', DEPLOY],
        ['sam deploy --guided', DEPLOY], ['sam delete', DEPLOY], ['sam sync --stack-name x', DEPLOY],
        [`docker push ${ecr}/app:1`, DEPLOY], [`docker image push ${ecr}/app:1`, DEPLOY], [`docker buildx build --push -t ${ecr}/app:1 .`, DEPLOY],
        ['docker push public.ecr.aws/x/app:1', DEPLOY], ['docker push "$IMAGE"', DEPLOY], ['podman push $IMAGE', DEPLOY],
        ['copilot svc deploy', DEPLOY], ['copilot deploy --name x', DEPLOY], ['eb deploy', DEPLOY], ['eb terminate prod', DEPLOY],
        ['amplify publish', DEPLOY], ['amplify push --yes', DEPLOY]
    ]);
    await approve([
        'cdk synth', 'cdk diff MyStack', 'npx cdk diff', 'cdk diff "$STACK"', 'sam build', 'sam validate',
        'docker push myrepo/app:1', 'docker push ghcr.io/org/app:1', `docker build -t ${ecr}/app:1 .`, `docker tag app ${ecr}/app:1`,
        'copilot svc ls', 'eb status', 'amplify status', 'git commit -m "cdk deploy in CI"', 'echo cdk deploy', 'grep -rn "sam deploy" docs'
    ]);
});

test('finding 9: Terraform commands that change state without an apply are left, reads of state are not', async () => {
    await leftBy([
        ['terraform import aws_s3_bucket.b b', STATE], ['terragrunt import x y', STATE], ['tofu state rm aws_s3_bucket.b', STATE],
        ['terraform state mv a b', STATE], ['terraform state push errored.tfstate', STATE], ['terraform state replace-provider a b', STATE],
        ['terraform taint aws_instance.x', STATE], ['terraform untaint aws_instance.x', STATE], ['terraform force-unlock abc', STATE],
        ['terraform -chdir=infra state rm x', STATE], ['cd infra && terraform import a b', STATE],
        ['terraform apply', TERRAFORM], ['terragrunt destroy', TERRAFORM]
    ]);
    await approve([
        'terraform state list', 'terraform state show aws_s3_bucket.b', 'terraform state pull', 'terraform plan', 'terraform output',
        'terraform validate', 'terraform fmt', 'terraform init', 'echo terraform import'
    ]);
});
