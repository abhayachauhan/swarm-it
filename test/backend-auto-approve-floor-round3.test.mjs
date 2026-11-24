// Round 3 of the review of the floor policy (24 Nov 2026), plus the user's choices of that day: a timed window that survives a reload,
// `atlantis apply`, a script written and run later, the AWS read list, interpreter argument lists, the guard on FLOOR_RULES, the screen
// path, AWS deploys without the aws CLI, Terraform state commands, MCP tools that send, share or delete, and the policy in the log.
// A test here asserts the exact decision, the code and the rule, so a command left for a different reason fails it.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
        ['gh pr comment 123 --body "atlantis $ACTION -d infra/prod"', TERRAFORM],
        [`gh pr comment 123 --body 'atlantis "apply"'`, TERRAFORM],
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
        ['amplify publish', DEPLOY], ['amplify push --yes', DEPLOY],
        // Image names that come from a file or from an output option, and a deploy tool that reads but is handed a command to run.
        [`docker buildx build --push=1 -t ${ecr}/app:1 .`, DEPLOY], [`docker buildx build --output type=image,name=${ecr}/app,push=T .`, DEPLOY],
        ['docker compose push', DEPLOY], ['docker buildx bake --push', DEPLOY], [`docker buildx build --output type=image,name=${ecr}/app,push=true .`, DEPLOY],
        ['cdk synth --app "aws s3 rm s3://b/k --recursive"', AWS]
    ]);
    await approve([
        'cdk synth', 'cdk diff MyStack', 'npx cdk diff', 'cdk diff "$STACK"', 'sam build', 'sam validate',
        'docker push myrepo/app:1', 'docker push ghcr.io/org/app:1', `docker build -t ${ecr}/app:1 .`, `docker tag app ${ecr}/app:1`,
        'copilot svc ls', 'eb status', 'amplify status', 'git commit -m "cdk deploy in CI"', 'echo cdk deploy', 'grep -rn "sam deploy" docs',
        'docker compose up', 'docker compose build', 'docker buildx build -t app:1 .', 'cdk synth --app "node bin/app.js"'
    ]);
});

test('finding 3: a script written now is read for the commands in it, since the run later only names the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'round3-'));
    const write = ({ file, content }) => request('Write', { file_path: join(dir, file), content });
    await expectAll([
        // The reviewer's: Write deploy.sh holding terraform apply, then bash deploy.sh.
        [{ file: 'deploy.sh', content: '#!/bin/bash\nset -e\nterraform apply -auto-approve\n' }, TERRAFORM],
        [{ file: 'run', content: '#!/usr/bin/env bash\naws s3 rm s3://b --recursive --profile p\n' }, AWS],
        [{ file: 'ci.zsh', content: 'cd infra\nterragrunt run-all apply\n' }, TERRAFORM],
        [{ file: 'Makefile', content: 'deploy:\n\tterraform apply\n' }, TERRAFORM],
        // A command word held in a variable, in a Makefile that also names terraform, may be the apply.
        [{ file: 'infra.mk', content: 'TF = terraform\ndeploy:\n\t$(TF) apply\n' }, 'command word is a variable'],
        [{ file: 'p.py', content: 'import os\nos.system("terraform apply")\n' }, TERRAFORM],
        [{ file: 'x.mjs', content: "import { execSync } from 'node:child_process';\nexecSync(`aws s3 rm s3://b/k --recursive`);\n" }, AWS],
        [{ file: 'package.json', content: '{"scripts":{"deploy":"cdk deploy --all"}}' }, DEPLOY],
        [{ file: 'post.ts', content: 'await sh("gh pr comment 1 --body \\"atlantis apply\\"");\n' }, TERRAFORM],
        // An argument list holds no command line: the program's name beside a call that runs programs is enough.
        [{ file: 'tf.py', content: 'import subprocess\nsubprocess.run(["terraform", "apply", "-auto-approve"])\n' }, TERRAFORM],
        [{ file: 'rm.mjs', content: "import { spawnSync } from 'node:child_process';\nspawnSync('aws', ['s3', 'rm', 's3://b/k']);\n" }, AWS],
        [{ file: 'fish.fish', content: 'terraform apply\n' }, TERRAFORM]
    ], rule => left(rule), write);
    // Edit and MultiEdit put the new text in the same file, so it is read the same way.
    const edit = request('Edit', { file_path: join(dir, 'deploy.sh'), old_string: 'echo hi', new_string: 'terraform destroy' });
    const multi = request('MultiEdit', { file_path: join(dir, 'deploy.sh'), edits: [{ old_string: 'a', new_string: 'echo ok' }, { old_string: 'b', new_string: 'sam deploy' }] });
    const { api, dispose } = await start();
    try {
        assert.deepEqual(await judge(api, edit), left(TERRAFORM));
        assert.deepEqual(await judge(api, multi), left(DEPLOY));
        // A shell script too long to read inside Kelpi's deadline is the user's.
        assert.deepEqual(await judge(api, write({ file: 'long.sh', content: '#!/bin/sh\n' + 'echo hi\n'.repeat(600) })), [ABSTAIN, 'TOO_LONG', undefined, 'too long to check']);
    } finally { dispose(); }
    await expectAll([
        [{ file: 'ok.sh', content: '#!/bin/bash\nset -e\necho hi\nterraform plan\naws s3 ls\ndocker build -t app .\n' }],
        [{ file: 'app.ts', content: "import { S3Client } from '@aws-sdk/client-s3';\nconst client = new S3Client({ region: 'ap-southeast-2' });\nconst provider = 'aws';\nconst rows = [1, 2].map(n => `${n}`);\n" }],
        [{ file: 'app.js', content: "const x = $('#a'); const y = [1, 2]; // don't run terraform apply here\n" }],
        [{ file: 'notes.md', content: '# Deploy\n\nRun `terraform apply` and then `atlantis apply`.\n' }],
        [{ file: 'package.json', content: '{"dependencies":{"aws-cdk-lib":"2.1.0","@aws-sdk/client-s3":"3.0.0"},"scripts":{"build":"tsc","synth":"cdk synth"}}' }],
        [{ file: 'Makefile', content: 'build:\n\t$(CC) -o app main.c\n\ntest:\n\tnpm test\n' }],
        [{ file: 'plan.mk', content: 'plan:\n\tterraform plan\n\taws s3 ls\n' }],
        [{ file: 'check.py', content: 'import subprocess\nsubprocess.run(["git", "status"])\nprint("terraform plan")\n' }],
        [{ file: 'tool.mjs', content: "import { spawnSync } from 'node:child_process';\nspawnSync('git', ['status']);\n" }]
    ], () => approved, write);
});

test('finding 7: a rule the floor selects by name must be on the never list, and that is checked when the module loads', async () => {
    assert.doesNotThrow(() => AA.checkFloorRules());
    assert.throws(() => AA.checkFloorRules(new Set([...AA.FLOOR_RULES, 'terraform apply or destroy, renamed'])),
        { message: 'the floor names a rule that is not on the never-auto-approve list: "terraform apply or destroy, renamed"' });
    // Renaming a never rule is the mistake the guard exists for: the floor would drop it without a word.
    assert.throws(() => AA.checkFloorRules(AA.FLOOR_RULES, AA.NEVER_AUTO_APPROVE.map(rule => (rule.name === 'aws write' ? { ...rule, name: 'aws changes' } : rule))),
        { message: 'the floor names a rule that is not on the never-auto-approve list: "aws write"' });
    const source = await readFile(new URL('../backend/autoapprove.mjs', import.meta.url), 'utf8');
    assert.match(source, /^checkFloorRules\(\);$/m, 'the check runs at the top level of the module');
});

const MCP_SEND = 'mcp send or delete';

test('finding 9: MCP tools that send, share or delete are left, and drafts and reads are not', async () => {
    const input = { channel: 'C1', text: 'hi' };
    await expectAll([
        ['mcp__claude_ai_Slack__slack_send_message', MCP_SEND], ['mcp__claude_ai_Slack__slack_schedule_message', MCP_SEND],
        ['mcp__claude_ai_Gmail__send_message', MCP_SEND], ['mcp__claude_ai_Gmail__forward', MCP_SEND], ['mcp__claude_ai_Gmail__reply', MCP_SEND],
        ['mcp__claude_ai_Gmail__trash_thread', MCP_SEND], ['mcp__claude_ai_Google_Drive__share_file', MCP_SEND], ['mcp__claude_ai_Google_Drive__trash_file', MCP_SEND],
        ['mcp__claude_ai_Notion__notion-delete-pages', MCP_SEND], ['mcp__missive__create_post', MCP_SEND], ['mcp__linear-server__delete_comment', MCP_SEND],
        ['mcp__claude_ai_Granola__remove_note_from_folder', MCP_SEND], ['mcp__x__archiveThread', MCP_SEND], ['mcp__x__publishRelease', MCP_SEND]
    ], rule => left(rule), tool => request(tool, input));
    await expectAll([
        // Drafts stay a draft, and every read and ordinary change stays approved.
        ['mcp__claude_ai_Gmail__create_draft'], ['mcp__claude_ai_Slack__slack_send_message_draft'], ['mcp__missive__draft_reply'], ['mcp__claude_ai_Gmail__delete_draft'],
        ['mcp__claude_ai_Slack__slack_read_channel'], ['mcp__claude_ai_Gmail__search_threads'], ['mcp__linear-server__get_issue'], ['mcp__claude_ai_Slack__slack_add_reaction'],
        ['mcp__buildkite__create_pipeline_schedule'], ['mcp__post-office__list_items'], ['mcp__linear-server__save_issue']
    ], () => approved, tool => request(tool, input));
});

test('finding 8 and 9: under the floor a screen card for a file write is left, as is a Tool use card that sends; a Bash card and other tools are answered', async () => {
    const api = makeSwarmApi({});
    const dispose = registerAll(api);
    await dispose.ready;
    await api.command('get-state', { workspaceID: 'ws1' });
    await api.command('auto-approve', { on: true, hours: 8 });
    const card = (header, text) => ['╭──────────────────╮', ` ${header}`, '', `   ${text}`, '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'].join('\n');
    const enters = () => api.callsTo('terminal.sendKey').filter(c => c.args[0] === 'w1' && c.args[1] === 'enter').length;
    const show = async text => { api.captureStore.w1 = text; await sleep(100); api.captureStore.w1 = 'working'; await sleep(60); };
    // The reviewer's: a relative settings.json, in a pane whose folder is ~/.claude, names nothing under .claude.
    await show(card('Edit file', 'settings.json'));
    await show(card('Write file', 'notes.txt'));
    await show(card('Create file', 'src/new.mjs'));
    await show(card('Tool use', 'Slack - slack_send_message(channel_id: "C1", message: "hi")'));
    assert.equal(enters(), 0, 'none of the four gets an Enter');
    await show(card('Bash command', 'git status'));
    await show(card('Tool use', 'Slack - slack_add_reaction(channel_id: "C1", name: "eyes")'));
    await show(card('Read file', 'settings.json'));
    assert.equal(enters(), 3, 'a Bash card, a Tool use card that only reacts and a Read card are answered');
    const entries = (await api.command('auto-approve-log', {})).entries.reverse();
    assert.deepEqual(entries.map(e => [e.command, e.ok, e.code, e.rule, e.policy]), [
        ['settings.json', false, 'PATH', undefined, 'floor'],
        ['notes.txt', false, 'PATH', undefined, 'floor'],
        ['src/new.mjs', false, 'PATH', undefined, 'floor'],
        ['Slack - slack_send_message(channel_id: "C1", message: "hi")', false, 'NEVER', MCP_SEND, 'floor'],
        ['git status', true, undefined, undefined, 'floor'],
        ['Slack - slack_add_reaction(channel_id: "C1", name: "eyes")', true, undefined, undefined, 'floor'],
        ['settings.json', true, undefined, undefined, 'floor']
    ]);
    assert.equal(entries[0].reason, 'a file write seen only on the screen: where it lands cannot be followed');
    dispose();
});

test('finding 10: every log entry says which policy decided, and the policy is logged once at the start', async () => {
    const lines = [];
    const info = mock.method(console, 'info', line => { lines.push(line); });
    try {
        await AA.load(storeWith(new Map()));
        process.env.SWARM_AUTO_APPROVE_POLICY = 'careful';
        await AA.load(storeWith(new Map()));
    } finally { info.mock.restore(); delete process.env.SWARM_AUTO_APPROVE_POLICY; }
    assert.deepEqual(lines.map(line => JSON.parse(line)), [
        { event: 'swarm.auto-approve.policy', policy: 'floor' },
        { event: 'swarm.auto-approve.policy', policy: 'careful' }
    ]);
    const { api, dispose } = await start();
    try {
        assert.equal((await judge(api, bash('ls')))[0].behavior, 'allow');
        assert.equal((await api.command('auto-approve-log', {})).entries[0].policy, 'floor');
        process.env.SWARM_AUTO_APPROVE_POLICY = 'careful';
        assert.equal((await judge(api, bash('ls')))[0].behavior, 'allow');
        const [careful, floor] = (await api.command('auto-approve-log', {})).entries;
        assert.deepEqual([careful.policy, floor.policy], ['careful', 'floor']);
        // A decision that leaves the request is logged with the policy too.
        assert.equal((await judge(api, bash('terraform apply')))[0].behavior, 'abstain');
        assert.equal((await api.command('auto-approve-log', {})).entries[0].policy, 'careful');
    } finally { delete process.env.SWARM_AUTO_APPROVE_POLICY; dispose(); }
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
