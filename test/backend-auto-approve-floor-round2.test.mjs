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

test('finding 1: a heredoc written to a file is read as shell when the same command runs or sources that file', async () => {
    const write = (body, run, tool = "cat > /tmp/payload.sh <<'EOF'") => `${tool}\n${body}\nEOF\n${run}`;
    await leftBy([
        // The reviewer's: the body was removed as stored text, then run.
        [write('terraform apply', 'bash /tmp/payload.sh'), TERRAFORM],
        [write('terraform apply', 'sh /tmp/payload.sh'), TERRAFORM],
        [write('terraform apply', 'zsh -x /tmp/payload.sh'), TERRAFORM],
        [write('terraform apply', 'source /tmp/payload.sh'), TERRAFORM],
        [write('terraform apply', '. /tmp/payload.sh'), TERRAFORM],
        [write('terraform apply', 'chmod +x /tmp/payload.sh && /tmp/payload.sh'), TERRAFORM],
        [write('terraform apply', 'chmod 755 /tmp/payload.sh\ncd /tmp\n./payload.sh'), TERRAFORM],
        [write('terraform destroy -auto-approve', 'sudo bash /tmp/payload.sh'), TERRAFORM],
        [write('#!/bin/bash\nset -e\naws s3 rm s3://b/k --recursive --profile p', 'bash /tmp/payload.sh'), AWS],
        [write('aws --profile p ec2 terminate-instances --instance-ids i-1', 'xargs -n1 bash < /dev/null; bash /tmp/payload.sh'), AWS],
        [write('terraform apply', 'bash /tmp/payload.sh', "tee /tmp/payload.sh <<'EOF'"), TERRAFORM],
        [write('terraform apply', 'bash /tmp/payload.sh', "cat >> /tmp/payload.sh <<-'EOF'"), TERRAFORM],
        [write('os.system("terraform apply")', 'python3 /tmp/payload.sh'), TERRAFORM],
        [write('terraform apply', 'echo done && bash /tmp/payload.sh'), TERRAFORM],
        // Run through a wrapper or a variable the shell fills in.
        [write('terraform apply', 'nice sudo bash /tmp/payload.sh'), TERRAFORM],
        [write('terraform apply', '$RUN /tmp/payload.sh'), TERRAFORM],
        // A command that is not a plain reader or stager, handed the file just written by path or by name, may run it.
        [write('terraform apply', 'make -f /tmp/payload.sh'), TERRAFORM],
        [write('aws s3 rm s3://b/k --profile p', 'crontab payload.sh', "cat > payload.sh <<'EOF'"), AWS],
        [write('terraform apply', 'awk -f /tmp/payload.sh x'), TERRAFORM],
        // A copy, move or link gives the file another name, and running that name runs it.
        [write('terraform apply', 'cp /tmp/payload.sh /tmp/run.mk\nmake -f /tmp/run.mk'), TERRAFORM],
        [write('terraform apply', 'mv /tmp/payload.sh /tmp/a.sh && cp /tmp/a.sh /tmp/b.sh && crontab /tmp/b.sh'), TERRAFORM],
        // Fed to a shell on stdin, it is left by Kelpi's own rule for code piped into a shell.
        [write('terraform apply', 'bash < /tmp/payload.sh'), PIPED]
    ]);
    // Plain storage stays approved: nothing runs the file, so nothing in it is a command.
    await approve([
        write('terraform apply', 'echo written'),
        "cat > /tmp/payload.sh <<'EOF'\nterraform apply\nEOF",
        write('run terraform apply after review', 'git add /tmp/payload.sh'),
        write('aws s3 rm s3://b/k', "bash -c 'echo hi'"),
        write('terraform apply', 'cat /tmp/payload.sh | grep terraform'),
        write('terraform apply', 'chmod +x /tmp/payload.sh\nls -l /tmp/payload.sh\ngit add /tmp/payload.sh\ncp /tmp/payload.sh /tmp/copy.sh\nwc -l /tmp/payload.sh'),
        // A script that is run but holds nothing the floor leaves is not a prompt.
        write('echo hi\nls /tmp', 'bash /tmp/payload.sh'),
        write('#!/bin/bash\naws s3 ls --profile p\nterraform plan', 'chmod +x /tmp/payload.sh && /tmp/payload.sh'),
        // A commit message is not a file.
        "git commit -F - <<'EOF'\nDocument the terraform apply flow\nEOF\nbash scripts/check.sh"
    ]);
});

test('finding 2: claude and codex global options are read with their values before the subcommand is found', async () => {
    await leftBy([
        // The reviewer's: the value of --settings was read as the subcommand, so the `mcp add` behind it was never checked.
        ['claude --settings /tmp/custom.json mcp add evil -- echo ok', SETTINGS],
        ['claude --model x config set allowedTools Bash', SETTINGS],
        ['claude --model opus --settings /tmp/s.json --permission-mode plan mcp remove evil', SETTINGS],
        ['claude --settings=/tmp/s.json mcp add-json evil \'{"command":"x"}\'', SETTINGS],
        ['claude -p --verbose --add-dir /tmp plugin install x@y', SETTINGS],
        ['codex -c model=x mcp add evil -- npx evil', SETTINGS],
        ['codex --config sandbox_mode=read-only --profile p mcp remove evil', SETTINGS],
        ['codex -m gpt-6 -s workspace-write mcp login evil', SETTINGS],
        ['sudo claude --settings /tmp/s.json mcp add evil -- npx evil', SETTINGS],
        // An option this does not know may take a value or not, so an `mcp` or `config` word anywhere after it is left.
        ['claude --some-new-option value mcp add evil -- npx evil', SETTINGS],
        ['claude --resume abc config set x y', SETTINGS],
        ['codex --some-new-option mcp add evil -- npx evil', SETTINGS],
        // A subcommand or verb the shell fills in.
        ['claude --model x $SUB add evil', SETTINGS],
        ['claude --model x mcp $VERB evil', SETTINGS],
        ['claude --verbose --no-chrome --some-new-option value $SUB add evil', SETTINGS],
        ['claude --verbose --no-chrome --some-new-option value "$SUB" add evil', SETTINGS],
        ['claude --verbose --no-chrome --some-new-option value $(echo mcp add) evil', SETTINGS],
        ['claude --verbose --no-chrome --some-new-option value mcp "$VERB" evil', SETTINGS],
        // A literal space beside an unquoted expansion does not stop it splitting: $SUB can be `mcp add`.
        ['claude --verbose --no-chrome --model x $SUB" " add evil', SETTINGS],
        ["claude --verbose --no-chrome --model x mcp $V' ' evil", SETTINGS],
        // Any option value the shell fills in is left, quoted or not: `"$@"` and `"${list[@]}"` make several words even inside double quotes.
        ['claude --verbose --no-chrome --model "$M" mcp list', SETTINGS],
        ['claude --verbose --no-chrome --model "$@" mcp list', SETTINGS],
        ['claude --verbose --no-chrome --model "${args[@]}" mcp list', SETTINGS],
        // A subcommand or verb word with a space of its own is a sentence, unless an expansion in it makes several words.
        ['claude --verbose --no-chrome --some-new-option value mcp "$@ " evil', SETTINGS],
        ['claude --verbose --no-chrome --some-new-option value "${args[@]} " add evil', SETTINGS],        // An option value the shell fills in and does not quote can split into several words and move the subcommand.
        ['claude --verbose --no-chrome --model $M mcp list', SETTINGS],
        // (an attached value with a `$` in it is left earlier still, by the rule for a word the shell builds)
        ['claude --verbose --no-chrome --model=$M mcp list', 'shell expansion builds a word'],
        // The verb may stand any distance behind `mcp`, after options of its own.
        ['claude mcp --scope user --transport http --header a:b --header c:d add evil http://x', SETTINGS]
    ]);
    await approve(['claude --settings /tmp/custom.json mcp list', 'claude --model x mcp get x', 'claude --settings /tmp/s.json --version',
        "claude -p --resume abc --permission-mode auto 'Write the updated result to /tmp/r.md. Reply done.'", "claude --verbose --model x -p 'explain how mcp add works'",
        "codex -c model=x exec 'fix the tests'", 'codex --profile p mcp list', "claude --some-new-option value 'explain mcp'", 'claude --model x plugin list',
        'claude --verbose --no-chrome --resume abc "Review $FILE now"', 'claude --verbose --no-chrome --model x mcp list']);
});

test('finding 3: standard and privilege wrappers are looked through in any order before the piped-into-shell and ruled-command checks', async () => {
    await leftBy([
        // The reviewer's: `command` stopped one reader and `sudo` stopped the other, so neither reached bash.
        ['cat /tmp/payload | command sudo bash', PIPED],
        ['cat /tmp/payload | sudo command env bash', PIPED],
        ['cat /tmp/payload | nice sudo sh', PIPED],
        ['cat /tmp/payload | env A=1 timeout 5 sudo -u root bash', PIPED],
        ['cat /tmp/payload | sudo -u root nohup nice -n 5 zsh', PIPED],
        ['cat /tmp/payload | sudo exec -a x ionice -c 3 dash', PIPED],
        ['cat /tmp/payload | pkexec command bash', PIPED],
        ['cat /tmp/payload | command sudo python3', PIPED],
        // The same chains in front of the commands the floor rules name.
        ['sudo command env terraform apply', TERRAFORM],
        ['nice sudo command aws s3 rm s3://b/k --profile p', AWS],
        ['command sudo $T apply', 'command word is a variable'],
        ['nice sudo sh -c "$(echo x | base64 -d)"', 'shell fed generated code'],
        ['sudo command {rm,-rf,x}', 'shell expansion builds a word']
    ]);
    await approve(['cat /tmp/payload | command sudo grep x', 'nice sudo ls /tmp', 'command sudo tee /tmp/x', 'command -v git', 'env A=1 timeout 5 sudo -n true',
        'echo hi | command sudo -u root tee /tmp/x']);
});

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
