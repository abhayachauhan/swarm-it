import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    parseSummary, firstLines, findWorker, pendingRequest, formatElapsed, stateLabel,
    availableActions, normalizeMessage, linkSegments, resultError, paneIDFromState, sectionStart,
} from '../ui/thread/logic.js';

const fixture = name => readFileSync(fileURLToPath(new URL(`../ui/thread/fixtures/${name}`, import.meta.url)), 'utf8');

test('bold form', () => {
    const s = parseSummary(fixture('bold.md'));
    assert.equal(s.found, true);
    assert.equal(s.goal, 'Fix the lag in the repo list.');
    assert.equal(s.done, '- Memoised the selector\n- Added a regression test');
    assert.equal(s.next, 'Merge after review.');
    assert.equal(s.fallback, '');
});

test('heading form, ignores fenced headings and later headings', () => {
    const s = parseSummary(fixture('heading.md'));
    assert.equal(s.goal, 'Ship the thread view.');
    assert.match(s.done, /^Parser and tests\./);
    assert.match(s.done, /## Next/); // inside the fence, kept as content of Done
    assert.equal(s.next, 'Wire up the sidebar.');
});

test('bold with colon and inline text', () => {
    const s = parseSummary('**Goal:** one line\n**Done:**\nx\n- **Next** y\n');
    assert.equal(s.goal, 'one line');
    assert.equal(s.done, 'x');
    assert.equal(s.next, 'y');
});

test('missing sections: partial', () => {
    const s = parseSummary('**Goal**\nonly this\n');
    assert.equal(s.found, true);
    assert.equal(s.goal, 'only this');
    assert.equal(s.done, '');
    assert.equal(s.next, '');
});

test('missing sections: none gives first 40 lines', () => {
    const s = parseSummary(fixture('none.md'));
    assert.equal(s.found, false);
    assert.equal(s.goal, '');
    const lines = s.fallback.split('\n');
    assert.equal(lines.length, 40);
    assert.equal(lines[39], 'line 40');
});

test('empty and non-string input', () => {
    for (const v of ['', '   \n', null, undefined, 42]) {
        const s = parseSummary(v);
        assert.equal(s.found, false);
        assert.equal(s.fallback, '');
    }
});

test('headings present but empty fall back to first lines', () => {
    const s = parseSummary('## Goal\n## Done\n## Next\n');
    assert.equal(s.found, false);
    assert.match(s.fallback, /## Goal/);
});

test('only first occurrence of a section counts', () => {
    const s = parseSummary('**Goal**\nfirst\n**Goal**\nsecond\n');
    assert.equal(s.goal, 'first');
});

test('hostile markup is returned verbatim, never altered or interpreted', () => {
    const s = parseSummary(fixture('hostile.md'));
    assert.equal(s.goal, '<img src=x onerror="alert(1)">');
    assert.ok(s.done.includes("<script>alert('xss')</script>"));
    assert.ok(s.done.includes('javascript:alert(1)'));
    assert.ok(s.next.includes('<iframe src="https://evil.example"></iframe>'));
});

test('hostile text in fallback is verbatim', () => {
    const s = parseSummary('<script>x</script>\nplain');
    assert.equal(s.fallback, '<script>x</script>\nplain');
});

test('sectionStart', () => {
    assert.deepEqual(sectionStart('## Done'), { name: 'done', rest: '' });
    assert.equal(sectionStart('## Doneness'), null);
    assert.equal(sectionStart('plain text'), null);
});

test('firstLines', () => {
    assert.equal(firstLines('a\nb\nc', 2), 'a\nb');
    assert.equal(firstLines(null), '');
});

const snapshot = {
    workers: [{ paneID: 'p1', state: 'waiting' }, { paneID: 'p2', state: 'done' }],
    attention: [
        { id: 'a', type: 'Complete', paneID: 'p1', text: '', createdAt: 'x' },
        { id: 'b', type: 'Request', paneID: 'p1', text: '', command: 'rm -rf /', createdAt: 'x' },
        { id: 'c', type: 'Request', paneID: 'p2', text: '', createdAt: 'x', handledAt: 'y' },
        { id: 'd', type: 'Request', paneID: 'p1', text: '', command: 'ls', createdAt: 'z' },
    ],
};

test('findWorker', () => {
    assert.equal(findWorker(snapshot, 'p2').state, 'done');
    assert.equal(findWorker(snapshot, 'nope'), null);
    assert.equal(findWorker(null, 'p1'), null);
});

test('pendingRequest picks latest unhandled Request for pane', () => {
    assert.equal(pendingRequest(snapshot, 'p1').id, 'd');
    assert.equal(pendingRequest(snapshot, 'p2'), null);
    assert.equal(pendingRequest(null, 'p1'), null);
});

test('formatElapsed', () => {
    assert.equal(formatElapsed(5), '5s');
    assert.equal(formatElapsed(65), '1m 05s');
    assert.equal(formatElapsed(3725), '1h 02m');
    assert.equal(formatElapsed(-1), '');
    assert.equal(formatElapsed(NaN), '');
});

test('stateLabel', () => {
    assert.equal(stateLabel('waiting'), 'Waiting for you');
    assert.equal(stateLabel('weird'), 'Unknown');
});

test('availableActions', () => {
    assert.equal(availableActions({ state: 'done' }).accept, true);
    assert.equal(availableActions({ state: 'done', accepted: true }).accept, false);
    assert.equal(availableActions({ state: 'running' }).accept, false);
    assert.equal(availableActions(null).send, false);
});

test('normalizeMessage, resultError, paneIDFromState', () => {
    assert.equal(normalizeMessage('  hi \n'), 'hi');
    assert.equal(normalizeMessage(null), '');
    assert.equal(resultError({ ok: true }), '');
    assert.equal(resultError({ ok: false, error: 'DIRTY tree' }), 'DIRTY tree');
    assert.equal(resultError(undefined), 'Command failed');
    assert.equal(paneIDFromState({ paneID: 'p1' }), 'p1');
    assert.equal(paneIDFromState({}), null);
    assert.equal(paneIDFromState(null), null);
});

test('result links keep surrounding prose and reject unsafe or malformed targets', () => {
    assert.deepEqual(linkSegments('See [the guide](https://example.com/docs), then https://example.org/a.'), [
        { text: 'See ' }, { text: 'the guide', url: 'https://example.com/docs' }, { text: ', then ' },
        { text: 'https://example.org/a', url: 'https://example.org/a' }, { text: '.' },
    ]);
    assert.deepEqual(linkSegments('[run](javascript:alert(1)) <script>x</script>'), [
        { text: '[run](javascript:alert(1)) <script>x</script>' },
    ]);
    assert.deepEqual(linkSegments(''), []);
});

import { createChangeLock, requestOrigin, LOCK_MS } from '../ui/thread/logic.js';

test('createChangeLock locks Approve and Deny for 500 ms after the request, prompt or position changes', () => {
    const req = (id, hash) => ({ id, type: 'Request', paneID: 'p', promptHash: hash });
    const lock = createChangeLock();
    assert.equal(LOCK_MS, 500);
    assert.equal(lock.locked(0), false, 'nothing pending');
    lock.observe({ attention: [req('a', 'h1')] }, 'p', 1000);
    assert.equal(lock.locked(1499), true);
    assert.equal(lock.locked(1500), false);
    lock.observe({ attention: [req('a', 'h1')] }, 'p', 2000);
    assert.equal(lock.locked(2000), false, 'same request again does not relock');
    lock.observe({ attention: [req('b', 'h1')] }, 'p', 3000);
    assert.equal(lock.locked(3100), true, 'a different request');
    lock.observe({ attention: [req('b', 'h2')] }, 'p', 4000);
    assert.equal(lock.locked(4100), true, 'same id, new prompt');
    lock.observe({ attention: [{ id: 'z', type: 'Error', paneID: 'q' }, req('b', 'h2')] }, 'p', 5000);
    assert.equal(lock.locked(5100), true, 'moved in the list');
    assert.equal(lock.remaining(5100), 400);
    lock.observe({ attention: [] }, 'p', 6000);
    assert.equal(lock.locked(6001), false, 'request gone');
});

test('requestOrigin shows the pane id next to the worker label', () => {
    assert.equal(requestOrigin({ label: 'repo-lag', paneID: 'w1' }, { paneID: 'w1' }), 'repo-lag (w1)');
    assert.equal(requestOrigin(null, { paneID: 'w1' }), 'w1');
    assert.equal(requestOrigin({ label: 'w1', paneID: 'w1' }, { paneID: 'w1' }), 'w1');
});

// The view itself (origin line, change lock, Back button) is driven in thread-app.test.mjs.

import { coordinatorPaneID } from '../ui/thread/logic.js';

test('coordinatorPaneID: the orchestrator pane id, or null when none is known', () => {
    assert.equal(coordinatorPaneID({ orchestrator: { paneID: 'orch', label: 'coordinator' } }), 'orch');
    assert.equal(coordinatorPaneID({ orchestrator: null }), null);
    assert.equal(coordinatorPaneID(null), null);
    assert.equal(coordinatorPaneID({ orchestrator: { paneID: '' } }), null);
});
