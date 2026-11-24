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
        for (const [command, rule] of commands) assert.deepEqual(await judge(api, make(command)), expected(rule), typeof command === 'string' ? command : JSON.stringify(command));
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
        [write('terraform apply', 'rsync /tmp/payload.sh /tmp/r.mk && make -f /tmp/r.mk'), TERRAFORM],
        // The file's own name as the command word, with the folder on the PATH.
        [write('aws s3 rm s3://b/k --profile p', 'chmod +x payload.sh\nPATH=.:$PATH payload.sh', "cat > payload.sh <<'EOF'"), AWS],
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

test('finding 4: an MCP tool that writes, moves or copies a file is followed to where the file lands, as Write is', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'floor2-')));
    try {
        await mkdir(join(root, 'home', '.claude'), { recursive: true });
        await mkdir(join(root, 'repo'));
        const settings = join(root, 'home', '.claude', 'settings.json');
        await writeFile(settings, '{}');
        await symlink(settings, join(root, 'repo', 'notes.json'));
        await symlink(join(root, 'home', '.claude'), join(root, 'repo', 'cfg'));
        await mkdir(join(root, 'home', '.codex'));
        await symlink(join(root, 'home', '.codex'), join(root, 'repo', 'codex-link'));
        await link(settings, join(root, 'repo', 'hard.json'));
        await writeFile(join(root, 'repo', 'plain.txt'), 'x');
        const { api, dispose } = await start();
        try {
            const mcp = (tool, input) => judge(api, request(`mcp__filesystem__${tool}`, input));
            const settingsLeft = left(SETTINGS);
            // The reviewer's: a symlink to an agent settings file, written through an MCP tool, was approved without any file system lookup.
            assert.deepEqual(await mcp('write_file', { path: join(root, 'repo', 'notes.json'), content: 'x' }), settingsLeft, 'symlink to the file');
            assert.deepEqual(await mcp('edit_file', { path: join(root, 'repo', 'cfg', 'settings.json'), edits: [] }), settingsLeft, 'symlinked folder');
            assert.deepEqual(await mcp('move_file', { source: join(root, 'repo', 'plain.txt'), destination: join(root, 'repo', 'notes.json') }), settingsLeft, 'move onto a link');
            assert.deepEqual(await mcp('copy_file', { src: join(root, 'repo', 'plain.txt'), dest: join(root, 'repo', 'cfg', 'settings.json') }), settingsLeft, 'copy into a linked folder');
            assert.deepEqual(await mcp('write_file', { args: { filePath: join(root, 'repo', 'notes.json') }, content: 'x' }), settingsLeft, 'a path field nested in the input');
            assert.deepEqual(await mcp('write_file', { path: `file://${join(root, 'repo', 'notes.json')}`, content: 'x' }), settingsLeft, 'a file:// URL');
            assert.deepEqual(await mcp('write_file', { path: join(root, 'repo', 'hard.json'), content: 'x' }), [ABSTAIN, 'HARDLINK', undefined, 'writes to a file with more than one name (hard link)']);
            assert.deepEqual(await mcp('write_file', { path: 'repo/x.json', content: 'x' }), [ABSTAIN, 'PATH', undefined, 'not an absolute path']);
            assert.deepEqual(await mcp('write_file', { path: '~/notes.txt', content: 'x' }), [ABSTAIN, 'PATH', undefined, 'not an absolute path']);
            assert.deepEqual(await mcp('write_file', { path: `${root}/repo/../repo/x.json`, content: 'x' }), [ABSTAIN, 'PATH', undefined, 'a path with . or .. in it']);
            // A second destination is checked too, and so is every one of them, up to four.
            assert.deepEqual(await mcp('copy_files', { paths: [join(root, 'repo', 'plain.txt'), join(root, 'repo', 'notes.json')] }), settingsLeft, 'second of several');
            assert.deepEqual(await mcp('copy_files', { paths: Array.from({ length: 5 }, (_, n) => join(root, 'repo', `f${n}.txt`)) }),
                [ABSTAIN, 'PATH', undefined, 'writes to more than 4 files, too many to check']);
            // A tool is followed unless its name plainly only reads, so a name nobody listed (`stash_file`) is checked like `write_file`.
            assert.deepEqual(await mcp('stash_file', { path: join(root, 'repo', 'notes.json') }), settingsLeft, 'a tool name no list has');
            assert.deepEqual(await mcp('read_and_replace', { path: join(root, 'repo', 'notes.json') }), settingsLeft, 'a read word beside a write word');
            // Moved or copied into a folder, a file keeps its name there: the folder `.claude` gets `settings.json` or `hooks` from a file of that name.
            assert.deepEqual(await mcp('copy_file', { src: join(root, 'repo', 'plain.txt'), dest: join(root, 'home', '.claude') }), settingsLeft, 'into the settings folder');
            assert.deepEqual(await mcp('move_file', { source: join(root, 'repo', 'settings.json'), destination: join(root, 'repo', 'cfg') }), settingsLeft, 'into a linked settings folder');
            // The rules folder of Codex is named with a slash after it, so a folder called `rules` moved into a linked `.codex` is caught too.
            assert.deepEqual(await mcp('copy_file', { src: join(root, 'repo', 'rules'), dest: join(root, 'repo', 'codex-link') }), settingsLeft, 'a rules folder into a linked .codex');
            // A name with a read word and a word that changes a file is not a plain read: `get_and_extract`, `read_then_chmod`.
            for (const tool of ['get_and_extract', 'read_then_unzip', 'list_and_chmod', 'get_and_chown', 'read_and_unlink']) {
                assert.deepEqual(await mcp(tool, { path: join(root, 'repo', 'notes.json') }), settingsLeft, tool);
            }
            // A key that is plainly a file says so whatever it holds: a bare name is a relative path, left. Under `target` or `folder` it may be a branch or a label.
            for (const input of [{ path: 'notes' }, { destination: 'inbox' }, { filePath: 'out' }, { dest_path: 'x' }, { paths: ['notes'] }, { args: { file: 'x' } }]) {
                assert.deepEqual(await mcp('stash_file', input), [ABSTAIN, 'PATH', undefined, 'not an absolute path'], JSON.stringify(input));
            }
            // What stays approved: ordinary files, new files, folders that exist, reads, and fields that are not places on this machine.
            for (const [tool, input] of [
                ['move_file', { source: join(root, 'repo', 'plain.txt'), destination: join(root, 'repo') }],
                ['get_file', { path: 'notes' }],
                ['stash_file', { target: 'main', name: 'v1' }],
                ['stash_file', { path: '', note: 'unset' }],
                ['write_file', { path: join(root, 'repo', 'plain.txt'), content: 'x' }],
                ['write_file', { path: join(root, 'repo', 'new', 'file.txt'), content: 'x' }],
                ['create_directory', { path: join(root, 'repo') }],
                ['move_file', { source: join(root, 'repo', 'plain.txt'), destination: join(root, 'repo', 'other.txt') }],
                ['read_file', { path: join(root, 'repo', 'plain.txt') }],
                ['get_file_info', { path: join(root, 'repo', 'notes.json') }],
                ['upload_file', { uri: 'https://example.com/a.png' }],
                ['create_release', { target: 'main', name: 'v1' }],
                ['save_note', { title: 'x', folder: 'inbox', body: 'y' }]
            ]) assert.deepEqual(await mcp(tool, input), approved, tool);
            assert.deepEqual(await judge(api, request('mcp__slack__slack_send_message', { channel: 'C1', text: 'hi' })), approved);
        } finally { dispose(); }
        // A landing place that cannot be told is left: this is the same lookup Write makes, with the same limits.
        const denied = { realpath: () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })), lstat: () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })) };
        const unresolved = await AA.judgeFloorRequest('mcp__filesystem__write_file', { path: '/x/y.txt', content: 'z' }, denied);
        assert.equal(unresolved.allow, false);
        assert.equal(unresolved.code, 'PATH');
        assert.equal(unresolved.reason, 'could not tell where it writes (EACCES)');
    } finally { await import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })); }
});

test('finding 5: an MCP call with an executable and an args array is judged as the one command line it stands for', async () => {
    const run = input => request('mcp__x__run', input);
    const UNREADABLE = AA.UNREADABLE_EXEC_RULE;
    await leftBy([
        // The reviewer's: the strings were checked one by one, and the flattened line put field names between the words.
        [{ executable: 'aws', args: ['s3', 'rm', 's3://bucket/key', '--profile', 'p'] }, AWS],
        [{ command: 'terraform', args: ['apply', '-auto-approve'] }, TERRAFORM],
        [{ cmd: 'bash', argv: ['-c', 'terraform apply'] }, TERRAFORM],
        [{ params: { program: '/usr/local/bin/aws', arguments: ['ec2', 'terminate-instances', '--instance-ids', 'i-1'] } }, AWS],
        [{ command: ['aws', 's3', 'rm', 's3://b/k'] }, AWS],
        [{ binary: 'sudo', args: ['-u', 'root', 'terraform', 'destroy'] }, TERRAFORM],
        [{ server: { command: 'npx', args: ['-y', 'x'] }, steps: [{ executable: 'terragrunt', args: ['destroy'] }] }, TERRAFORM],
        [{ executable: 'cp', args: ['/tmp/x', '/Users/x/.claude/settings.json'] }, SETTINGS],
        [{ executable: 'claude', args: ['--settings', '/tmp/s.json', 'mcp', 'add', 'evil'] }, SETTINGS],
        // A word with a quote or a space in it stays one word: this is `aws ssm put-parameter --value 'a b'`, a write.
        [{ executable: 'aws', args: ['ssm', 'put-parameter', '--name', 'n', '--value', "it's a b", '--profile', 'p'] }, AWS],
        // Several fields that name a program or hold arguments are each read: the first of a kind does not hide the others.
        [{ command: 'echo', cmd: 'aws', args: ['s3', 'rm', 's3://b/k'] }, AWS],
        [{ executable: 'aws', args: ['s3api', 'list-buckets'], argv: ['s3', 'rm', 's3://b/k'] }, AWS],
        [{ executable: 'sudo terraform', args: ['destroy'] }, TERRAFORM],
        [{ executable: 'aws', args: 's3 rm s3://b/k' }, AWS],
        [{ command: 'terraform', options: ['apply'] }, TERRAFORM],
        [{ command: 'terraform', params: 'destroy' }, TERRAFORM],
        // More than one program field or one args field: each pairing is read, and when none breaks a rule the object is still left, because the
        // tool's own order of putting them together is not known.
        [{ executable: 'git', args: ['status'], argv: ['log'] }, UNREADABLE],
        [{ command: 'git', cmd: 'ls', args: ['status'] }, UNREADABLE],
        // A layout this cannot read is left: no field names the program, or the arguments are not plain words.
        [{ command: ['aws', { x: 1 }] }, UNREADABLE],
        [{ args: ['s3', 'rm'] }, UNREADABLE],
        [{ tool: 'aws', args: ['s3', 'rm', 's3://b/k'] }, UNREADABLE],
        [{ executable: 'aws', args: ['s3', { nested: true }] }, UNREADABLE],
        [{ command: 'ls', options: { argv: ['x'] } }, UNREADABLE]
    ], run);
    await approve([
        { executable: 'git', args: ['status'] }, { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] }, { command: ['ls', '-la'] },
        { executable: 'aws', args: ['s3', 'ls', '--profile', 'p'] }, { executable: 'aws', args: ['s3api', 'list-objects-v2', '--bucket', 'b', '--profile', 'p'] },
        { executable: 'aws', args: ['s3', 'cp', 's3://b/k', '/tmp/k', '--profile', 'p'] }, { command: 'ls -la' }, { executable: 'terraform', args: ['plan'] },
        { channel: 'C1', text: 'hello', tags: ['a', 'b'], ids: [1, 2, 3] }, { question: 'Lunch?', options: ['pizza', 'sushi'] }, { command: 'ls', options: 'a' },
        { executable: 'sudo ls', args: ['-la'] }
    ], run);
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
