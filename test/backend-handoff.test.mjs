import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handoff, validateHandoff } from '../backend/handoff.mjs';
import { makeFakeApi } from './backend-fake-api.mjs';

const summary = {
    sourcePaneID: 'source-1', fromAgent: 'codex', toAgent: 'claude',
    goal: 'Finish the plugin update',
    keyPoints: ['The tests pass', 'Review the current diff'],
    next: 'Review and commit the change'
};

test('handoff creates a private summary and starts the other CLI beside the source', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swarm-handoff-'));
    const api = makeFakeApi({ panes: [{ id: 'source-1', agent: 'codex', workspaceID: 'ws1', type: 'shell', workingDirectory: "/tmp/repo's work" }] });
    try {
        const result = await handoff(api, { settings: {} }, summary, { root, uuid: () => 'one' });
        assert.equal(result.ok, true);
        assert.equal(result.paneID, 'split-1');
        assert.equal(result.handoffPath, join(root, 'one.md'));
        assert.match(readFileSync(result.handoffPath, 'utf8'), /## Goal\n\nFinish the plugin update/);
        assert.match(readFileSync(result.handoffPath, 'utf8'), /## Key points\n\n- The tests pass\n- Review the current diff/);
        assert.equal(statSync(result.handoffPath).mode & 0o777, 0o600);
        assert.deepEqual(api.callsTo('panes.split')[0].args, ['source-1', { direction: 'horizontal', focus: true, path: "/tmp/repo's work" }]);
        const sent = api.callsTo('terminal.send')[0].args;
        assert.equal(sent[0], 'split-1');
        assert.match(sent[1], /&& claude /);
        assert.match(sent[1], /one\.md/);
        assert.match(sent[1], /cd '\/tmp\/repo'"'"'s work'/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('handoff accepts a source whose Kelpi agent field is blank', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swarm-handoff-'));
    const api = makeFakeApi({ panes: [{ id: 'source-1', agent: null, workspaceID: 'ws1', type: 'shell', workingDirectory: '/tmp/repo' }] });
    try {
        const result = await handoff(api, { settings: {} }, { ...summary, fromAgent: 'claude', toAgent: 'codex' }, { root, uuid: () => 'two' });
        assert.equal(result.ok, true);
        assert.match(api.callsTo('terminal.send')[0].args[1], /&& codex /);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('handoff rejects invalid summaries and a mismatched source without opening a pane', async () => {
    const api = makeFakeApi({ panes: [{ id: 'source-1', agent: 'claude', workspaceID: 'ws1', type: 'shell', workingDirectory: '/tmp/repo' }] });
    assert.equal(validateHandoff({ ...summary, keyPoints: [] }).code, 'BAD_POINTS');
    assert.equal(validateHandoff({ ...summary, goal: 'bad\nline' }).code, 'BAD_GOAL');
    assert.equal(validateHandoff({ ...summary, toAgent: 'codex' }).code, 'BAD_AGENT');
    const result = await handoff(api, { settings: {} }, summary);
    assert.equal(result.code, 'SOURCE_AGENT');
    assert.equal(api.callsTo('panes.split').length, 0);
});
