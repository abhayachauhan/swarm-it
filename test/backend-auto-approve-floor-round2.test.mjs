// Round 2 of the Codex deep review of the floor policy (24 Nov 2026): the gaps an honest mistake could reach, each with the reviewer's own
// reproduction and what must stay approved beside it. The user's decision was that the floor guards against honest mistakes, not against an
// agent that deliberately disguises a command, so the ways that need disguise are listed as known limits (see the last test) and not fixed.
// A test here asserts the exact decision, the code and the rule, so a command left for a different reason fails it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, link, realpath } from 'node:fs/promises';
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
const { AWS_READ_OPS } = await import('../backend/aws-read-ops.mjs');

const SELECTED = { selected: 'local.swarm-view.permissions' };
const ALLOW = { behavior: 'allow' };
const ABSTAIN = { behavior: 'abstain' };
const request = (toolName, toolInput, extra = {}) => ({ paneID: 'w1', workspaceID: 'ws1', agent: 'claude', toolName, toolInput, ...extra });
const bash = (command, input = {}) => request('Bash', { command, description: 'd', ...input });
const TERRAFORM = 'terraform apply or destroy';
const AWS = 'aws write';
const PIPED = 'piped or heredoc into a shell or interpreter';
const SETTINGS = AA.FLOOR_SETTINGS_RULE;

async function start() {
    const api = makeSwarmApi({ permissions: SELECTED });
    const dispose = registerAll(api);
    await dispose.ready;
    await api.command('auto-approve', { on: true });
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
        for (const [command, rule] of commands) assert.deepEqual(await judge(api, make(command)), expected(rule), command);
    } finally { dispose(); }
}
const leftBy = (commands, make) => expectAll(commands, left, make);
const approve = (commands, make) => expectAll(commands.map(c => [c]), () => approved, make);

test('finding 6: mediaconvert describe-endpoints creates an endpoint unless it says GET_ONLY, and other reads that mint or create are left', async () => {
    await leftBy([
        // The reviewer's: DEFAULT, also the mode when none is given, creates the account endpoint.
        ["bash -c 'aws --profile p mediaconvert describe-endpoints --mode DEFAULT'", AWS],
        ['aws --profile p mediaconvert describe-endpoints', AWS],
        ['aws mediaconvert describe-endpoints --mode DEFAULT --profile p', AWS],
        // GET_ONLY must be the only mode, and nothing may be able to override it: an input file, an unknown option or a word the shell fills in.
        ['aws mediaconvert describe-endpoints --mode GET_ONLY --mode DEFAULT --profile p', AWS],
        ['aws mediaconvert describe-endpoints --mode GET_ONLY --cli-input-json file://x.json --profile p', AWS],
        ['aws mediaconvert describe-endpoints --mode GET_ONLY --cli-input-yaml file://x.yaml --profile p', AWS],
        ['aws mediaconvert describe-endpoints --mode $M --profile p', AWS],
        ['aws mediaconvert describe-endpoints --mode get_only --profile p', AWS],
        ['aws mediaconvert describe-endpoints --mode', AWS],
        // The second scan of the read list: reads whose docs say they create, mint or write something.
        ['aws gamelift get-instance-access --fleet-id f --instance-id i --profile p', AWS],
        ['aws gamelift get-compute-access --fleet-id f --compute-name c --profile p', AWS],
        ['aws s3control get-data-access --account-id 1 --target s3://b --permission READ --profile p', AWS],
        ['aws codepipeline get-job-details --job-id j --profile p', AWS],
        ['aws taxsettings get-tax-registration-document --destination-s3-location bucket=b,prefix=p --profile p', AWS],
        ['aws evs get-depot-url --rotate --profile p', AWS],
        ['bash -c "aws payment-cryptography get-parameters-for-import --key-material-type TR34_KEY_BLOCK"', AWS]
    ]);
    await approve([
        'aws --profile p mediaconvert describe-endpoints --mode GET_ONLY',
        'aws mediaconvert describe-endpoints --mode=GET_ONLY --region ap-southeast-2 --profile p',
        'bash -c "aws mediaconvert describe-endpoints --mode GET_ONLY --profile p"',
        'aws mediaconvert list-jobs --profile p', 'aws mediaconvert describe-endpoints --help'
    ]);
    for (const [service, op] of [['mediaconvert', 'describe-endpoints'], ['gamelift', 'get-instance-access'], ['gamelift', 'get-compute-access'], ['s3control', 'get-data-access'],
        ['codepipeline', 'get-job-details'], ['codepipeline', 'get-third-party-job-details'], ['taxsettings', 'get-tax-registration-document'], ['evs', 'get-depot-url'],
        ['ec2', 'get-flow-logs-integration-template'], ['inspector', 'get-assessment-report'], ['importexport', 'get-shipping-label'],
        ['endusermessaging', 'validate-notify-code-verification'], ['payment-cryptography', 'get-parameters-for-export'], ['payment-cryptography', 'get-parameters-for-import'],
        ['kinesis-video-signaling', 'get-ice-server-config'], ['groundstation', 'get-agent-task-response-url'], ['support', 'get-attachment-upload-links'],
        ['socialmessaging', 'get-whats-app-flow-preview']]) {
        assert.equal(AWS_READ_OPS.get(service)?.has(op) ?? false, false, `${service} ${op}`);
    }
    for (const [service, op] of [['mediaconvert', 'list-jobs'], ['gamelift', 'describe-fleet-attributes'], ['codepipeline', 'get-pipeline-state'], ['support', 'describe-cases'],
        ['ec2', 'describe-instances'], ['secretsmanager', 'get-random-password'], ['apigateway', 'get-sdk']]) {
        assert.equal(AWS_READ_OPS.get(service)?.has(op), true, `${service} ${op}`);
    }
});
