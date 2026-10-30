import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBriefPulls, checkSummary } from '../backend/brief-pulls.mjs';
import { pullReferences } from '../backend/brief-references.mjs';
const url = 'https://github.com/owner/repo/pull/876';
const brief = { goal: 'Goal', pullRequests: [{ url, title: 'Proposed change', status: 'Merged', assessmentHead: 'abc', risk: 'Low', validation: 'Session reports dry run' }] };
const tick = () => new Promise(resolve => setImmediate(resolve));
const metadata = () => ({ url, title: 'Enforce venue access checks', state: 'OPEN', isDraft: false, reviewDecision: 'CHANGES_REQUESTED',
    body: 'Prevents access to another venue. Real dry run remains outstanding.', headRefOid: 'abc', files: [{ path: 'src/guard.ts' }],
    statusCheckRollup: [{ conclusion: 'SUCCESS' }, { state: 'PENDING' }], additions: 10, deletions: 2 });
test('summary receives real PR purpose, changed files, bounded diff and checks before model generation', async () => {
    const calls = []; let clock = 0;
    const pulls = createBriefPulls({ now: () => clock, run: async (...args) => {
        calls.push(args); return { stdout: args[1][1] === 'diff' ? 'diff --git a/guard.ts b/guard.ts\n+checkVenue();' : JSON.stringify(metadata()) };
    } });
    const context = JSON.stringify({ firstGoal: 'Block cross-venue access', recent: 'Review the change', pullReferences: [url] });
    const packed = JSON.parse(await pulls.prepare(context, null));
    assert.equal(packed.pullEvidence[0].body, metadata().body);
    assert.deepEqual(packed.pullEvidence[0].files, ['src/guard.ts']);
    assert.match(packed.pullEvidence[0].diff, /checkVenue/);
    assert.equal(packed.pullEvidence[0].checks, '1 passed, 1 pending');
    const result = pulls.enrich(brief).pullRequests[0];
    assert.equal(result.title, metadata().title); assert.equal(result.status, 'Changes requested'); assert.equal(result.risk, 'Low');
    assert.equal(calls.length, 2); assert.equal(calls[0][0], 'gh');
    assert.deepEqual(calls[1][1], ['pr', 'diff', url, '--patch']);
    assert.equal(brief.pullRequests[0].status, 'Merged');
    clock = 300001; pulls.enrich(brief); await tick(); assert.equal(calls.length, 4); pulls.dispose();
});
test('checks never turn skipped, pending, failed or missing evidence into validated', () => {
    assert.equal(checkSummary([]), 'No checks reported');
    assert.equal(checkSummary([{ conclusion: 'SKIPPED' }, { state: 'PENDING' }, { conclusion: 'FAILURE' }]), '1 failed, 1 pending, 1 skipped');
    assert.equal(checkSummary([{ conclusion: 'MYSTERY' }]), '1 unknown');
});
test('untrusted URLs never execute; network failure cannot confirm a model claim', async () => {
    const calls = [];
    const pulls = createBriefPulls({ run: async (...args) => { calls.push(args); throw Error('offline'); } });
    assert.deepEqual(pulls.enrich({ pullRequests: [{ url: 'https://evil.example/$(echo hacked)' }] }).pullRequests, []);
    await tick(); assert.equal(calls.length, 0);
    const packed = JSON.parse(await pulls.prepare(JSON.stringify({ pullReferences: [url] }), null));
    assert.equal(packed.pullEvidence[0].status, 'Unverified');
    assert.equal(pulls.enrich(brief).pullRequests[0].risk, 'Unknown. Current GitHub evidence and assessment revision are not verified.');
    assert.equal(pulls.enrich(brief).pullRequests[0].checks, 'GitHub checks unavailable'); assert.equal(calls.length, 1); pulls.dispose();
});
test('a changed PR revision invalidates the old risk and runtime validation assessment', async () => {
    const pulls = createBriefPulls({ run: async (_cmd, args) => ({ stdout: args[1] === 'diff' ? 'patch' : JSON.stringify({ ...metadata(), headRefOid: 'new' }) }) });
    await pulls.prepare(JSON.stringify({ pullReferences: [url] }), null);
    const result = pulls.enrich(brief).pullRequests[0];
    assert.equal(result.risk, 'Not assessed. The pull request changed since this assessment.');
    assert.equal(result.validation, 'Recheck runtime and test evidence for the new revision.');
    assert.equal(brief.pullRequests[0].risk, 'Low'); pulls.dispose();
});
test('diff failure retains metadata and identifies the assessment evidence gap', async () => {
    const pulls = createBriefPulls({ run: async (_cmd, args) => { if (args[1] === 'diff') throw Error('too large'); return { stdout: JSON.stringify(metadata()) }; } });
    const data = JSON.parse(await pulls.prepare(JSON.stringify({ pullReferences: [url] }), null)).pullEvidence[0];
    assert.equal(data.diffAvailable, false); assert.equal(data.body, metadata().body); pulls.dispose();
});
test('pull reference discovery binds numbers to explicit repositories in Claude and Codex tool records', () => {
    const input = [
        JSON.stringify({ message: { content: [{ type: 'tool_use', input: { command: 'gh pr view 842 --repo mr-yum/crew --json title' } }] } }),
        JSON.stringify({ payload: { arguments: JSON.stringify({ cmd: 'gh pr checks 3294 --repo mr-yum/serve-frontend' }) } }),
        'See mr-yum/crew-frontend#1573 and https://github.com/mr-yum/connect-infrastructure/pull/878',
        'PR #9999 has no repository evidence'
    ].join('\n');
    assert.deepEqual(pullReferences(input), ['https://github.com/mr-yum/crew/pull/842', 'https://github.com/mr-yum/serve-frontend/pull/3294',
        'https://github.com/mr-yum/connect-infrastructure/pull/878', 'https://github.com/mr-yum/crew-frontend/pull/1573']);
});
test('multiple large PR evidence records fit the model context without corrupting JSON', async () => {
    const urls = Array.from({ length: 6 }, (_, i) => url + i);
    const pulls = createBriefPulls({ run: async (_cmd, args) => ({ stdout: args[1] === 'diff' ? 'diff'.repeat(20000)
        : JSON.stringify({ ...metadata(), url: args[2], body: 'body'.repeat(20000), files: Array.from({ length: 100 }, () => ({ path: 'path'.repeat(100) })) }) }) });
    const text = await pulls.prepare(JSON.stringify({ recent: 'r'.repeat(20000), pullReferences: urls }), null);
    assert.ok(text.length <= 24000); assert.equal(JSON.parse(text).pullEvidence.length, 6); pulls.dispose();
});

test('short repository references require one explicit owner and ignore ordinary PR prose', () => {
    assert.deepEqual(pullReferences('https://github.com/mr-yum/serve-frontend/pull/3294\ncrew #842, crew-frontend #1573, Pipelines #878. Qlty flags issues on #3294.'),
        ['https://github.com/mr-yum/serve-frontend/pull/3294','https://github.com/mr-yum/crew/pull/842','https://github.com/mr-yum/crew-frontend/pull/1573','https://github.com/mr-yum/pipelines/pull/878']);
    const mixed = pullReferences('https://github.com/one/app/pull/1 https://github.com/two/app/pull/2 crew #842');
    assert.ok(!mixed.some(url => url.endsWith('/crew/pull/842')));
    assert.deepEqual(pullReferences('crew #842 and PR #878 with no owner evidence'), []);
});

test('oversized repository and pull identifiers never enter the evidence budget', () => {
    assert.deepEqual(pullReferences('https://github.com/' + 'x'.repeat(1000) + '/repo/pull/123'), []);
    assert.deepEqual(pullReferences('https://github.com/owner/repo/pull/' + '1'.repeat(100)), []);
});
