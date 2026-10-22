import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTranscript, handoff, requestHandoff, validateHandoff } from '../backend/handoff.mjs';
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

test('pane header transfers the exact source transcript and closes the source after target send', async () => {
    const home = mkdtempSync(join(tmpdir(), 'swarm-handoff-home-'));
    const sessionID = '11111111-2222-4333-8444-555555555555';
    const transcript = join(home, '.codex', 'sessions', '2026', '10', '22', `rollout-${sessionID}.jsonl`);
    mkdirSync(join(home, '.codex', 'sessions', '2026', '10', '22'), { recursive: true });
    writeFileSync(transcript, '{"type":"session_meta"}\n');
    const api = makeFakeApi({ allowClose: true, panes: [{ id: 'source-1', agent: null, agentSessionID: sessionID, workspaceID: 'ws1', type: 'shell', workingDirectory: '/tmp/repo' }] });
    let closeLater;
    try {
        assert.deepEqual(await findTranscript(sessionID, null, { home }), { agent: 'codex', path: transcript });
        const result = await requestHandoff(api, { settings: {}, sessions: new Map() }, {}, { paneID: 'source-1' },
            { home, root: join(home, 'handoffs'), uuid: () => 'button', scheduleClose: fn => { closeLater = fn; } });
        assert.equal(result.ok, true);
        assert.equal(result.toAgent, 'claude');
        assert.equal(result.sourceSessionID, sessionID);
        assert.match(readFileSync(result.handoffPath, 'utf8'), /Source transcript: /);
        assert.match(readFileSync(result.handoffPath, 'utf8'), new RegExp(sessionID));
        assert.match(api.callsTo('terminal.send')[0].args[1], /&& claude /);
        assert.equal(api.callsTo('panes.close').length, 0);
        closeLater();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(api.callsTo('panes.close')[0].args, ['source-1']);
    } finally { rmSync(home, { recursive: true, force: true }); }
});

test('pane header leaves the source open when its session ID or transcript is missing', async () => {
    const api = makeFakeApi({ panes: [{ id: 'source-1', agent: 'codex', workspaceID: 'ws1', type: 'shell', workingDirectory: '/tmp/repo' }] });
    const noID = await requestHandoff(api, { sessions: new Map() }, {}, { paneID: 'source-1' });
    assert.equal(noID.code, 'NO_SESSION');
    assert.equal(api.callsTo('panes.split').length, 0);
    api.paneList[0].agentSessionID = '11111111-2222-4333-8444-555555555555';
    const home = mkdtempSync(join(tmpdir(), 'swarm-handoff-empty-'));
    try {
        const noTranscript = await requestHandoff(api, { sessions: new Map() }, {}, { paneID: 'source-1' }, { home });
        assert.equal(noTranscript.code, 'NO_TRANSCRIPT');
        assert.equal(api.callsTo('panes.split').length, 0);
        assert.equal(api.callsTo('panes.close').length, 0);
    } finally { rmSync(home, { recursive: true, force: true }); }
});

test('pane header finds a Claude transcript and starts Codex', async () => {
    const home = mkdtempSync(join(tmpdir(), 'swarm-handoff-claude-'));
    const sessionID = '11111111-2222-4333-8444-555555555555';
    const transcript = join(home, '.claude', 'projects', 'sample', `${sessionID}.jsonl`);
    mkdirSync(join(home, '.claude', 'projects', 'sample'), { recursive: true });
    writeFileSync(transcript, '{}\n');
    const api = makeFakeApi({ panes: [{ id: 'source-1', agent: 'claude', agentSessionID: sessionID, workspaceID: 'ws1', type: 'shell', workingDirectory: '/tmp/repo' }] });
    try {
        assert.deepEqual(await findTranscript(sessionID, 'claude', { home }), { agent: 'claude', path: transcript });
        const result = await requestHandoff(api, { settings: {}, sessions: new Map() }, {}, { paneID: 'source-1' },
            { home, root: join(home, 'handoffs'), uuid: () => 'claude', scheduleClose: () => {} });
        assert.equal(result.toAgent, 'codex');
        assert.match(api.callsTo('terminal.send')[0].args[1], /&& codex /);
    } finally { rmSync(home, { recursive: true, force: true }); }
});

test('handoff records the source session and closes it only after target send succeeds', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swarm-handoff-'));
    const sessionID = '11111111-2222-4333-8444-555555555555';
    const api = makeFakeApi({ allowClose: true, panes: [{ id: 'source-1', agent: 'codex', agentSessionID: sessionID, workspaceID: 'ws1', type: 'shell', workingDirectory: '/tmp/repo' }] });
    let closeLater;
    try {
        const result = await handoff(api, { settings: {} }, { ...summary, quitSource: true },
            { root, uuid: () => 'three', scheduleClose: fn => { closeLater = fn; } });
        assert.equal(result.ok, true);
        assert.equal(result.sourceSessionID, sessionID);
        assert.equal(result.sourceCloseScheduled, true);
        assert.equal(api.callsTo('panes.close').length, 0);
        assert.match(readFileSync(result.handoffPath, 'utf8'), new RegExp(`Source session ID: ${sessionID}`));
        assert.match(api.callsTo('terminal.send')[0].args[1], new RegExp(sessionID));
        closeLater();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(api.callsTo('panes.close')[0].args, ['source-1']);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
