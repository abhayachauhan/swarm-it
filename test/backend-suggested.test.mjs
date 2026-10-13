import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSuggested, joinWraps, commandProblem, wrapWidth } from '../backend/suggested.mjs';

const RULE = '─'.repeat(60);

test('the dist-upgrade example: Claude\'s wrap after -o is a space, and the ! prefix is dropped', () => {
    const capture = [
        "! ssh root@192.168.7.253 'DEBIAN_FRONTEND=noninteractive apt-get dist-upgrade -y -o",
        "  Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef'"
    ].join('\n');
    assert.deepEqual(findSuggested(capture), {
        kind: 'bang',
        command: "ssh root@192.168.7.253 'DEBIAN_FRONTEND=noninteractive apt-get dist-upgrade -y -o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef'"
    });
});

test('a ! line under Claude\'s bullet and indent rejoins wraps at that indent plus two', () => {
    const capture = [
        '⏺ Run this yourself:',
        '',
        '  ! npm run build --workspace',
        '    packages/client',
        '',
        '  Then reload.'
    ].join('\n');
    assert.equal(findSuggested(capture).command, 'npm run build --workspace packages/client');
});

test('a ! line in Claude\'s reply text wraps back to the column of the ! itself', () => {
    const capture = [
        '  Run it yourself so the password prints only in your own terminal:',
        '',
        "  ! ssh root@192.168.7.253 'bash -s' <",
        '  /private/tmp/claude-501/scratchpad/gdrive-setup.sh',
        '',
        '  It prints a PASSWORD and a SALT at the end.'
    ].join('\n');
    assert.equal(findSuggested(capture).command, "ssh root@192.168.7.253 'bash -s' < /private/tmp/claude-501/scratchpad/gdrive-setup.sh");
});

test('a second ! line at the same column is its own command, not a wrap', () => {
    const capture = ['  ! git status', '  ! git log -1'].join('\n');
    assert.equal(findSuggested(capture).command, 'git log -1');
});

test('a bare command paragraph in reply text, wrapped at its own indent, is found and rejoined', () => {
    const wide = '─'.repeat(74);
    const capture = [
        '  demo-shop, on staging. It has no logo set, so logoUrl will be',
        '  null:',
        '',
        "  curl -s https://api.example.com/graphql -H 'content-type:",
        "  application/json' -d '{\"query\":\"{ shop(slug:\\\"demo-shop\\\") {",
        '  slug name logoUrl openingHours timezone currencyCode',
        '  owner { id email } address { city country }',
        "  menu { id title } } }\"}' | jq",
        '',
        "  I'd avoid using real customer shop slugs.",
        wide, '> ', wide
    ].join('\n');
    assert.deepEqual(findSuggested(capture), {
        kind: 'bare',
        command: "curl -s https://api.example.com/graphql -H 'content-type: application/json' -d '{\"query\":\"{ shop(slug:\\\"demo-shop\\\") { slug name logoUrl openingHours timezone currencyCode owner { id email } address { city country } menu { id title } } }\"}' | jq"
    });
});

test('prose that starts with a command word is not a command', () => {
    assert.equal(findSuggested('  git is how we ship changes, and make builds them.\n'), null);
    assert.equal(findSuggested('  Then open the page and check it.'), null);
});

test('a ! command inside a sentence is found and cut at the sentence end', () => {
    // Pane 263F8CA8: a Next bullet whose sentence goes on after the command and wraps.
    const capture = [
        '  Next',
        '  - Log in again with ! aws sso login --profile Example-Admin-123456789012. I\'ll confirm the role is missing, then plan stage 11 locally.',
        '    The plan should show only the new role and its policy being added, with nothing changed or destroyed.',
        '  - Then comment atlantis plan -p identity on PR #86. The expected result is 31 resources to add and none destroyed.',
        '',
        RULE
    ].join('\n');
    assert.deepEqual(findSuggested(capture), { command: 'aws sso login --profile Example-Admin-123456789012', kind: 'inline' });
    assert.equal(findSuggested('  Run ! git status, then tell me.')?.command, 'git status');
    assert.equal(findSuggested('  Finally run ! make test')?.command, 'make test');
    assert.equal(findSuggested('  Wow! git is great'), null, 'a ! after a word is punctuation');
});

test('a URL split mid-token at the wrap width joins with nothing', () => {
    // The pane is 64 wide (its rule); the 63-character first line fills it, so the break is inside the URL.
    const first = '  ! curl -fsSL https://example.com/releases/download/v1.2.3/ins';
    assert.equal([...first].length, 63);
    const wide = '─'.repeat(64);
    const capture = [first, '    tall.sh | bash', '', wide, '> ', wide].join('\n');
    assert.equal(findSuggested(capture).command, 'curl -fsSL https://example.com/releases/download/v1.2.3/install.sh | bash');
    // The same lines with no width known: unsure, so a space.
    assert.equal(findSuggested([first, '    tall.sh | bash'].join('\n')).command, 'curl -fsSL https://example.com/releases/download/v1.2.3/ins tall.sh | bash');
});

test('a short line before a wrap is a space break even with a known width', () => {
    const capture = ['  ! echo one', '    two', RULE].join('\n');
    assert.equal(findSuggested(capture).command, 'echo one two');
});

test('a fenced block keeps each command on its own line and rejoins wraps inside it', () => {
    const capture = [
        'Run these:',
        '```bash',
        'cd ~/repos/app',
        'npm ci --no-audit --prefer-offline --loglevel',
        '  error',
        'npm test',
        '```',
        'Done.'
    ].join('\n');
    assert.deepEqual(findSuggested(capture), { kind: 'fence', command: 'cd ~/repos/app\nnpm ci --no-audit --prefer-offline --loglevel error\nnpm test' });
});

test('an unfenced indented command right after "Run ..." text is found', () => {
    const capture = ['⏺ Run the migration:', '', '    npx prisma migrate deploy', '', '  It is safe to re-run.'].join('\n');
    assert.deepEqual(findSuggested(capture), { kind: 'run', command: 'npx prisma migrate deploy' });
});

test('the LAST suggestion wins', () => {
    const capture = ['! echo first', '```sh', 'echo second', '```', '  ! echo third', 'some prose'].join('\n');
    assert.equal(findSuggested(capture).command, 'echo third');
    const fenceLast = ['! echo first', '```', 'echo second', '```'].join('\n');
    assert.equal(findSuggested(fenceLast).command, 'echo second');
});

test('no command: prose, an unclosed fence or a fence in another language finds nothing', () => {
    assert.equal(findSuggested('⏺ All tests pass.\n  Nothing to run.'), null);
    assert.equal(findSuggested('```bash\nnpm test'), null);
    assert.equal(findSuggested('```python\nprint(1)\n```'), null);
    assert.equal(findSuggested(''), null);
});

test('a line ending in a shell backslash keeps its real newline', () => {
    assert.equal(joinWraps(['docker run \\', '  --rm alpine'], 0), 'docker run \\\n  --rm alpine');
});

test('wrapWidth reads the widest rule line; commandProblem refuses control characters and empty text', () => {
    assert.equal(wrapWidth(['abc', RULE, '─'.repeat(30)]), 60);
    assert.equal(wrapWidth(['abc']), 0);
    assert.equal(commandProblem('echo hi'), null);
    assert.equal(commandProblem('echo a\necho b'), null);
    assert.match(commandProblem('echo \u001b[31m'), /control/);
    assert.match(commandProblem('echo\ttab'), /control/);
    assert.match(commandProblem('rm x\r'), /control/);
    assert.match(commandProblem('  '), /empty/);
    assert.match(commandProblem('echo safe ‮;hs.live'), /invisible/, 'bidi override');
    assert.match(commandProblem('rm​ -rf x'), /invisible/, 'zero-width space');
});
