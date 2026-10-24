import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
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
        assert.equal(result.handoffPath, null);
        const command = api.callsTo('terminal.send')[0].args[1];
        assert.match(command, /&& claude /);
        assert.ok(command.includes(`Read the Codex session ${sessionID} from ${transcript}`));
        assert.doesNotMatch(command, /Swarm-it handoff|summarize|Next section|use the swarm-it skill/i);
        assert.equal(api.callsTo('panes.close').length, 0);
        closeLater();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(api.callsTo('panes.close')[0].args, ['source-1']);
    } finally { rmSync(home, { recursive: true, force: true }); }
});

test('pane header needs a session ID, and lets the target locate the transcript when no local file is found', async () => {
    const api = makeFakeApi({ panes: [{ id: 'source-1', agent: 'codex', workspaceID: 'ws1', type: 'shell', workingDirectory: '/tmp/repo' }] });
    const noID = await requestHandoff(api, { sessions: new Map() }, {}, { paneID: 'source-1' });
    assert.equal(noID.code, 'NO_SESSION');
    assert.equal(api.callsTo('panes.split').length, 0);
    api.paneList[0].agentSessionID = '11111111-2222-4333-8444-555555555555';
    const home = mkdtempSync(join(tmpdir(), 'swarm-handoff-empty-'));
    try {
        const result = await requestHandoff(api, { sessions: new Map() }, {}, { paneID: 'source-1' }, { home, scheduleClose: () => {} });
        assert.equal(result.ok, true);
        assert.equal(result.handoffPath, null);
        assert.ok(api.callsTo('terminal.send')[0].args[1].includes(`Read the Codex session ${api.paneList[0].agentSessionID} and continue`));
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
        const command = api.callsTo('terminal.send')[0].args[1];
        assert.match(command, /&& codex /);
        assert.ok(command.includes(`Read the Claude session ${sessionID} from ${transcript}`));
        assert.doesNotMatch(command, /Swarm-it handoff|summarize|Next section|use the swarm-it skill/i);
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
        assert.equal(result.handoffPath, null);
        assert.match(api.callsTo('terminal.send')[0].args[1], new RegExp(sessionID));
        closeLater();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(api.callsTo('panes.close')[0].args, ['source-1']);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('session-only handoff accepts a session ID without a summary and rejects mismatched IDs', async () => {
    const sessionID = '11111111-2222-4333-8444-555555555555';
    const args = { sourcePaneID: 'source-1', fromAgent: 'claude', toAgent: 'codex', sourceSessionID: sessionID };
    assert.equal(validateHandoff(args), null);
    assert.equal(validateHandoff({ ...args, sourceSessionID: 'bad; id' }).code, 'BAD_SESSION');
    const api = makeFakeApi({ panes: [{ id: 'source-1', agent: 'claude', agentSessionID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', workingDirectory: '/tmp', workspaceID: 'ws1' }] });
    assert.equal((await handoff(api, { settings: {} }, args)).code, 'SESSION_MISMATCH');
    assert.equal(api.callsTo('panes.split').length, 0);
});

test('a failed target send leaves the source session open', async () => {
    const api = makeFakeApi({ allowClose: true, panes: [{ id: 'source-1', agent: 'claude', agentSessionID: '11111111-2222-4333-8444-555555555555', workingDirectory: '/tmp', workspaceID: 'ws1' }] });
    api.terminal.send = async () => { throw new Error('send failed'); };
    let scheduled = false;
    const result = await requestHandoff(api, { sessions: new Map() }, {}, { paneID: 'source-1' }, { scheduleClose: () => { scheduled = true; } });
    assert.equal(result.code, 'SEND_FAILED');
    assert.equal(scheduled, false);
    assert.equal(api.callsTo('panes.close').length, 0);
});

test('the helper transfers a session ID without reading a summary from stdin', () => {
    const root = mkdtempSync(join(tmpdir(), 'session-transfer-'));
    const sessionID = '11111111-2222-4333-8444-555555555555';
    const executable = join(root, 'kelpi');
    const payloadPath = join(root, 'payload.json');
    writeFileSync(executable, `#!${process.execPath}\nconst fs = require('node:fs'); const args = JSON.parse(process.argv.at(-1)); fs.writeFileSync(${JSON.stringify(payloadPath)}, JSON.stringify(args)); console.log(JSON.stringify({ok:true, toAgent:args.toAgent, paneID:'target-1', sourceSessionID:args.sourceSessionID, handoffPath:null}));\n`);
    chmodSync(executable, 0o700);
    try {
        const output = execFileSync(process.execPath, [fileURLToPath(new URL('../skills/swarm-it/swarm-handoff.mjs', import.meta.url)), '--from', 'claude', '--to', 'codex', '--session-id', sessionID], {
            input: '', encoding: 'utf8', timeout: 5000,
            env: { ...process.env, PATH: `${root}${delimiter}${process.env.PATH}`, KELPI_PANE_ID: 'source-1' }
        });
        const payload = JSON.parse(readFileSync(payloadPath, 'utf8'));
        assert.equal(payload.sourceSessionID, sessionID);
        assert.equal(payload.goal, undefined);
        assert.ok(output.includes(`source session ${sessionID}`));
        assert.doesNotMatch(output, /undefined/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
