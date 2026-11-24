// The floor policy (the default): auto-approve answers everything except terraform apply or destroy, AWS writes and the shell
// constructions that could hide either. SWARM_AUTO_APPROVE_POLICY=careful brings back the full never list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSwarmApi } from './backend-fake-api.mjs';

// Set before the backend loads: these are read once. The policy itself is read on every call.
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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const prompt = cmd => ['╭──────────────────╮', ' Bash command', '', `   ${cmd}`, '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'].join('\n');
const enters = (api, paneID) => api.callsTo('terminal.sendKey').filter(c => c.args[0] === paneID && c.args[1] === 'enter').length;
const request = (toolName, toolInput, extra = {}) => ({ paneID: 'w1', workspaceID: 'ws1', agent: 'claude', toolName, toolInput, ...extra });
const bash = (command, input = {}, extra = {}) => request('Bash', { command, description: 'd', ...input }, extra);

async function start(extra = {}) {
    const api = makeSwarmApi({ permissions: SELECTED, ...extra });
    const dispose = registerAll(api);
    await dispose.ready;
    await api.command('auto-approve', { on: true });
    return { api, dispose };
}
/** Decide one request and return what it did, with the log entry it left: `[decision, code, rule, reason]`. */
async function judge(api, args) {
    const decision = await api.decide(args);
    await api.idle();
    const entry = (await api.command('auto-approve-log', {})).entries[0];
    return [decision, entry.ok ? 'OK' : entry.code, entry.rule, entry.reason];
}

const FLOOR_LEFT = [
    ['terraform apply', 'terraform apply or destroy'],
    ['terragrunt apply --terragrunt-non-interactive', 'terraform apply or destroy'],
    ['terraform destroy -auto-approve', 'terraform apply or destroy'],
    ['tofu apply', 'terraform apply or destroy'],
    ['aws imagebuilder start-image-pipeline-execution --image-pipeline-arn arn:x --profile p', 'aws write'],
    ['aws ssm put-parameter --name /a --value b --profile p', 'aws write'],
    ['aws s3 cp ./file s3://bucket/key --profile p', 'aws write'],
    ['aws s3 cp ./file s3://bucket/key --acl public-read --profile p', 'aws write'],
    ['aws s3 rm s3://bucket/key --profile p', 'aws write'],
    ['aws s3 sync s3://bucket/a ./out --delete --profile p', 'aws write'],
    ['aws ec2 run-instances --image-id ami-1 --profile p', 'aws write'],
    ['aws lambda invoke --function-name f out.json --profile p', 'aws write'],
    ['aws ec2 --profile p terminate-instances --instance-ids i-1', 'aws write'],
    ['aws ec2', 'aws write'],
    ['xargs aws s3 rm', 'aws write'],
    ['echo x | aws s3 cp - s3://bucket/key --profile p', 'aws write'],
    ['xargs echo aws aws s3 rm', 'aws write'],
    ['bash -c "aws ec2 request-spot-fleet --profile p"', 'aws write'],
    ['/usr/local/bin/aws ec2 create-tags --resources i-1', 'aws write'],
    ['R=rm; $R -rf x', 'command word is a variable'],
    ['alias ll=ls', 'alias or eval'],
    ['eval "ls"', 'alias or eval'],
    ['git ${x}push origin main', 'shell expansion builds a word'],
    ['echo cm0gLXJmIHg= | base64 -d | sh', 'shell fed generated code'],
    ['$(echo rm) -rf x', 'command word from a substitution'],
    ["$'\\x72m' -rf x", 'ANSI-C escape'],
    ["env -S 'rm -rf x'", 'env -S']
];

test('floor: each floor rule is left for the user, with the exact rule in the log', async () => {
    const { api, dispose } = await start();
    for (const [command, rule] of FLOOR_LEFT) {
        assert.deepEqual(await judge(api, bash(command)), [ABSTAIN, 'NEVER', rule, AA.NEVER_REASON], command);
    }
    assert.equal((await api.command('auto-approve-log', {})).entries.filter(e => e.ok).length, 0);
    dispose();
});

test('floor: AWS reads, terraform plan and everything the old never list held back are approved', async () => {
    const { api, dispose } = await start();
    for (const command of [
        'aws sts get-caller-identity --profile p',
        'aws s3 ls s3://bucket --profile p',
        'aws ec2 describe-instances --profile p --region ap-southeast-2 --query "Reservations[].Instances[].InstanceId"',
        'aws --profile p ec2 describe-instances',
        'aws s3 cp s3://bucket/key ./out --profile p',
        'aws logs tail /aws/lambda/f --profile p',
        'aws s3 cp s3://bucket/key - --profile p',
        'gh pr create --title t --body "moves the aws account migration forward"',
        'cd ~/repos/aws',
        'aws ec2 wait instance-running --instance-ids i-1 --profile p',
        'grep -rn aws docs/',
        'echo aws s3 rm',
        'terraform plan -out plan.tfplan',
        'terragrunt plan',
        'gh pr merge 51 --squash',
        'git push --force-with-lease origin feature',
        'git push origin main',
        'rm -rf /tmp/scratch',
        'kubectl --context ap1-staging delete pod x',
        'sudo ls',
        'ls'
    ]) assert.deepEqual(await judge(api, bash(command)), [ALLOW, 'OK', undefined, undefined], command);
    dispose();
});

test('floor: a request that asks to run outside the sandbox is approved unless it breaks a floor rule', async () => {
    const { api, dispose } = await start();
    assert.deepEqual(await judge(api, bash('git fetch origin', { dangerouslyDisableSandbox: true })), [ALLOW, 'OK', undefined, undefined]);
    assert.deepEqual(await judge(api, bash('terraform apply', { dangerouslyDisableSandbox: true })), [ABSTAIN, 'NEVER', 'terraform apply or destroy', AA.NEVER_REASON]);
    dispose();
});

test('floor: file, Monitor and MCP requests are approved; a floor rule inside them is still left', async () => {
    const { api, dispose } = await start();
    assert.deepEqual(await judge(api, request('Write', { file_path: '/Users/x/repos/a.txt', content: 'x' })), [ALLOW, 'OK', undefined, undefined]);
    assert.deepEqual(await judge(api, request('Edit', { file_path: '/Users/x/.zshrc', old_string: 'a', new_string: 'b' })), [ALLOW, 'OK', undefined, undefined]);
    assert.deepEqual(await judge(api, request('Read', { file_path: '/Users/x/.ssh/config' })), [ALLOW, 'OK', undefined, undefined]);
    assert.deepEqual(await judge(api, request('Monitor', { command: 'tail -f /tmp/log' })), [ALLOW, 'OK', undefined, undefined]);
    assert.deepEqual(await judge(api, request('Monitor', { command: 'terraform apply' })), [ABSTAIN, 'NEVER', 'terraform apply or destroy', AA.NEVER_REASON]);
    assert.deepEqual(await judge(api, request('mcp__slack__slack_send_message', { channel: 'C1', text: 'hi' })), [ALLOW, 'OK', undefined, undefined]);
    assert.deepEqual(await judge(api, request('mcp__x__run', { command: 'aws s3 rm s3://b/k' })), [ABSTAIN, 'NEVER', 'aws write', AA.NEVER_REASON]);
    dispose();
});

test('floor: writes to agent settings files stay with the user; reads and other ~/.claude files are approved', async () => {
    const { api, dispose } = await start();
    const left = [ABSTAIN, 'NEVER', AA.FLOOR_SETTINGS_RULE, AA.NEVER_REASON];
    for (const command of [
        'sed -i "" s/ask/allow/ ~/.claude/settings.json',
        'cp /tmp/s.json /Users/x/.claude/settings.local.json',
        'echo "{}" > "$HOME/.claude/settings.json"',
        'jq ".permissions.allow += [\\"Bash\\"]" ~/.claude/settings.json > /tmp/s && mv /tmp/s ~/.claude/settings.json',
        'cat > ~/.claude/hooks/bash-guards.sh <<\'EOF\'\nexit 0\nEOF',
        'rm ~/.claude/hooks/bash-guards.sh',
        'node edit.mjs .claude/settings.json',
        'printf x >> ~/.codex/config.toml',
        'vim .mcp.json',
        'CLAUDE_CONFIG_DIR=/tmp/c claude',
        'mv /tmp/x ~/.claude.json'
    ]) assert.deepEqual(await judge(api, bash(command)), left, command);
    for (const [tool, path] of [['Write', '/Users/x/.claude/settings.json'], ['Edit', '/Users/x/repo/.claude/settings.local.json'],
        ['Write', '/Users/x/.claude/hooks/guard.sh'], ['Edit', '/Users/x/.codex/config.toml'], ['Write', '/Users/x/repo/.mcp.json']]) {
        assert.deepEqual(await judge(api, request(tool, { file_path: path, content: 'x', old_string: 'a', new_string: 'b' })), left, path);
    }
    for (const command of ['cat ~/.claude/settings.json', 'jq .permissions ~/.claude/settings.json', 'grep -n ask ~/.claude/settings.json',
        'ls ~/.claude/hooks/', 'echo note >> ~/.claude/projects/p/memory/MEMORY.md', 'git -C ~/repos/swarm-it log']) {
        assert.deepEqual(await judge(api, bash(command)), [ALLOW, 'OK', undefined, undefined], command);
    }
    for (const path of ['/Users/x/.claude/projects/p/memory/note.md', '/Users/x/.claude/skills/s/SKILL.md', '/Users/x/repo/CLAUDE.md']) {
        assert.deepEqual(await judge(api, request('Write', { file_path: path, content: 'x' })), [ALLOW, 'OK', undefined, undefined], path);
    }
    assert.deepEqual(await judge(api, request('Read', { file_path: '/Users/x/.claude/settings.json' })), [ALLOW, 'OK', undefined, undefined]);
    dispose();
});

test('floor: questions, unknown tools, empty input, long input and a Codex request that is not a verified Bash pane stay with the user', async () => {
    const { api, dispose } = await start();
    const tool = name => `auto-approve does not answer ${name} requests`;
    assert.deepEqual(await judge(api, request('AskUserQuestion', { questions: [] })), [ABSTAIN, 'TOOL', undefined, tool('AskUserQuestion')]);
    assert.deepEqual(await judge(api, request('ExitPlanMode', { plan: 'p' })), [ABSTAIN, 'TOOL', undefined, tool('ExitPlanMode')]);
    assert.deepEqual(await judge(api, bash('   ')), [ABSTAIN, 'NO_INPUT', undefined, 'no command']);
    assert.deepEqual(await judge(api, bash(`echo ${'a'.repeat(AA.MAX_REQUEST_TEXT)}`)), [ABSTAIN, 'TOO_LONG', undefined, 'too long to check']);
    assert.deepEqual(await judge(api, bash('ls', {}, { agent: 'codex' })), [ABSTAIN, 'AGENT', undefined, 'Codex request is not a verified Bash pane']);
    assert.deepEqual(await judge(api, bash('ls', {}, { agent: 'gemini' })), [ABSTAIN, 'AGENT', undefined, 'unknown agent']);
    dispose();
});

test('floor: off means abstain and no log, as before', async () => {
    const { api, dispose } = await start();
    await api.command('auto-approve', { on: false });
    assert.deepEqual(await api.decide(bash('ls')), ABSTAIN);
    dispose();
});

test('careful: SWARM_AUTO_APPROVE_POLICY=careful brings back the full never list and the sandbox check', async () => {
    const { api, dispose } = await start();
    process.env.SWARM_AUTO_APPROVE_POLICY = 'careful';
    try {
        assert.equal(AA.approvePolicy(), 'careful');
        assert.deepEqual(await judge(api, bash('gh pr merge 51 --squash')), [ABSTAIN, 'NEVER', 'gh pr merge or gh repo delete', AA.NEVER_REASON]);
        assert.deepEqual(await judge(api, bash('git push origin feature')), [ABSTAIN, 'NEVER', 'git push', AA.NEVER_REASON]);
        assert.deepEqual(await judge(api, bash('ls', { dangerouslyDisableSandbox: true })), [ABSTAIN, 'SANDBOX', undefined, 'asks to run outside the sandbox']);
        assert.deepEqual(await judge(api, bash('aws imagebuilder start-image-pipeline-execution --image-pipeline-arn a')), [ABSTAIN, 'NEVER', 'aws write', AA.NEVER_REASON]);
        assert.deepEqual(await judge(api, bash('ls')), [ALLOW, 'OK', undefined, undefined]);
    } finally { delete process.env.SWARM_AUTO_APPROVE_POLICY; }
    assert.equal(AA.approvePolicy(), 'floor');
    assert.equal(AA.approvePolicy({ SWARM_AUTO_APPROVE_POLICY: ' Careful ' }), 'careful');
    assert.equal(AA.approvePolicy({ SWARM_AUTO_APPROVE_POLICY: 'anything else' }), 'floor');
    dispose();
});

test('floor: the screen path (an older Kelpi, no provider) answers gh pr merge and leaves terraform apply and aws writes', async () => {
    const api = makeSwarmApi({});
    const dispose = registerAll(api);
    await dispose.ready;
    await api.command('get-state', { workspaceID: 'ws1' });
    await api.command('auto-approve', { on: true, hours: 8 });
    api.captureStore.w1 = prompt('gh pr merge 51 --squash');
    await sleep(100);
    api.captureStore.w1 = 'merged';
    await sleep(60);
    assert.equal(enters(api, 'w1'), 1);
    api.captureStore.w1 = prompt('aws ssm put-parameter --name /a --value b');
    await sleep(100);
    assert.equal(enters(api, 'w1'), 1, 'an aws write gets no Enter');
    const entries = (await api.command('auto-approve-log', {})).entries;
    assert.deepEqual(entries.map(e => [e.command, e.ok, e.code, e.rule]), [
        ['aws ssm put-parameter --name /a --value b', false, 'NEVER', 'aws write'],
        ['gh pr merge 51 --squash', true, undefined, undefined]
    ]);
    dispose();
});
