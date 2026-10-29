import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBriefPulls } from '../backend/brief-pulls.mjs';
const url = 'https://github.com/owner/repo/pull/876';
const brief = { goal: 'Goal', pullRequests: [{ url, title: 'Proposed change', status: 'Merged' }] };
const tick = () => new Promise(resolve => setImmediate(resolve));
test('pull titles and status come from read-only GitHub metadata, with bounded caching', async () => {
    const calls = []; let clock = 0;
    const pulls = createBriefPulls({ now: () => clock, run: async (...args) => {
        calls.push(args); return { stdout: JSON.stringify({ url, title: 'Enforce venue access checks', state: 'OPEN', isDraft: false, reviewDecision: 'CHANGES_REQUESTED' }) };
    } });
    assert.equal(pulls.enrich(brief).pullRequests[0].status, 'Unverified');
    await tick();
    assert.deepEqual(pulls.enrich(brief).pullRequests[0], { url, title: 'Enforce venue access checks', status: 'Changes requested' });
    assert.deepEqual(calls[0].slice(0, 2), ['gh', ['pr', 'view', url, '--json', 'title,url,state,isDraft,reviewDecision']]);
    assert.equal(calls.length, 1); assert.equal(brief.pullRequests[0].status, 'Merged');
    clock = 300001; pulls.enrich(brief); await tick(); assert.equal(calls.length, 2); pulls.dispose();
});
test('untrusted URLs never execute; network failure cannot confirm a model claim', async () => {
    const calls = [];
    const pulls = createBriefPulls({ run: async (...args) => { calls.push(args); throw Error('offline'); } });
    const unsafe = { pullRequests: [{ url: 'https://evil.example/$(echo hacked)', title: 'Bad' }] };
    assert.deepEqual(pulls.enrich(unsafe).pullRequests, []); await tick(); assert.equal(calls.length, 0);
    pulls.enrich(brief); await tick();
    assert.equal(pulls.enrich(brief).pullRequests[0].status, 'Unverified'); assert.equal(calls.length, 1); pulls.dispose();
});
