// A JSON query is text, not a hidden path pattern. On 26 Nov 2026 a coordinator's `gh pr ready ...; gh pr view ... --jq
// '"\(.state) \(.mergeCommit.oid[0:12])"'` was left as an agent settings write, because `.oid[0:12]` read like `~/.cl*de`. Only data
// quotes (jq or yq arguments, gh's --jq, -q, --template) change: other programs expand a quoted pattern themselves, so those stay left.
import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SWARM_AUTO_APPROVE_POLICY;
const AA = await import('../backend/autoapprove.mjs');

const judge = async command => {
    const r = await AA.judgeFloorRequest('Bash', { command, description: 'd' });
    return r.allow ? 'OK' : r.rule;
};
const SETTINGS = AA.FLOOR_SETTINGS_RULE;

test('the shape of the command left on 26 Nov is approved', async () => {
    const command = 'gh pr ready 1 -R acme/app 2>&1 | tail -1; gh pr merge 1 -R acme/app --squash --admin --match-head-commit 0123456789abcdef 2>&1 | tail -2; gh pr view 1 -R acme/app --json state,mergeCommit --jq \'"\\(.state) \\(.mergeCommit.oid[0:12])"\'; printf -- \'- MERGED #1.\\n\' >> /tmp/handoff.md';
    assert.equal(await judge(command), 'OK');
});

test('JSON queries for jq, yq and gh are text', async () => {
    for (const command of [
        "gh pr view 1 --json commits --jq '.commits[-1].oid'",
        "gh api repos/a/b/pulls -q '.[0].number'",
        "gh pr list --json number --template '{{range .}}{{.number}}{{end}}'",
        'jq ".items[0].name" out.json > /tmp/x',
        "yq '.a[0]' f.yaml",
        // An escaped quote mark does not end a double-quoted string, so `.a[0]` here is still inside it.
        'jq "\\".a[0]\\"" f.json > /tmp/x',
    ]) assert.equal(await judge(command), 'OK', command);
});

test('patterns that are expanded, by the shell or by the program they are given to, are still left', async () => {
    for (const command of [
        'cp /tmp/x ~/.cl*de/settings.json',
        "cp /tmp/x ~/'.cl'*de/settings.json",
        'cp /tmp/x ~/.{claude,x}/settings.json',
        "cp /tmp/x '~/.claude/settings.json'",
        'echo "$(cp /tmp/x ~/.cl*de/settings.json)"',
        "cp /tmp/x ~/.cl*de/settings.json 'unclosed",
        'cp /tmp/x "\\"" ~/.cl*de/settings.json "\\""',
        "cp /tmp/x $'a' ~/.cl*de/settings.json",
        "cp /tmp/x ~/.cl*de/settings.json # '",
        // Programs that expand a quoted pattern themselves (Claude review of 98ac229, finding 1).
        "bash -c 'cp /tmp/x ~/.cl*de/settings.json'",
        "zsh -c 'cp hook.sh ~/.{claude,codex}/hooks/'",
        "find ~ -path '*/.c?aude/settings.json' -exec cp /tmp/x {} \\;",
        "git checkout other -- '.cl*/settings.json'",
        "tar -xf x.tar -C ~ --wildcards '.cl*'",
        "ssh -q host 'cp /tmp/x ~/.cl*de/settings.json'",
        "gh pr view 1; bash -c 'cp /tmp/x ~/.cl*de/settings.json'",
        // Valid shell that a quote scan blind to here-documents or substitutions would misread (finding 2).
        "cat > /tmp/n <<EOF\ndon't\nEOF\ncp /tmp/a ~/.cl*de/settings.json; echo it\\'s",
        'n="$(grep -c \'"\' f)"; cp x ~/.cl*de/settings.json; echo it\\\'s',
    ]) assert.equal(await judge(command), SETTINGS, command);
});

test('text the quote scan does not model is read as written', () => {
    for (const text of [
        "cat > /tmp/n <<EOF\ndon't\nEOF\njq '.a[0]' f",
        "jq $'.a[0]' f",
        'jq "$(echo ".a[0]")" f',
        "jq `echo '.a[0]'` f",
        "jq '.a[0]' f # it's",
        "jq '.a[0] f",
    ]) assert.equal(AA.quotedGlobsInert(text), text, text);
    assert.equal(AA.quotedGlobsInert("jq '.a[0]' \"b{c}\"; bash -c 'ls ~/.c*'"), "jq '.a_0]' \"b_c}\"; bash -c 'ls ~/.c*'");
});
