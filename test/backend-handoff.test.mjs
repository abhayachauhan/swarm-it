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
    const api = makeFakeApi({ captures: { 'source-1': '' }, allowClose: true, panes: [{ id: 'source-1', agent: 'codex', workspaceID: 'ws1', type: 'shell', workingDirectory: "/tmp/repo's work" }] });
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
    const api = makeFakeApi({ captures: { 'source-1': '' }, allowClose: true, panes: [{ id: 'source-1', agent: null, workspaceID: 'ws1', type: 'shell', workingDirectory: '/tmp/repo' }] });
    try {
        const result = await handoff(api, { settings: {} }, { ...summary, fromAgent: 'claude', toAgent: 'codex' }, { root, uuid: () => 'two' });
        assert.equal(result.ok, true);
        assert.match(api.callsTo('terminal.send')[0].args[1], /&& codex /);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('handoff rejects invalid summaries and a mismatched source without opening a pane', async () => {
    const api = makeFakeApi({ captures: { 'source-1': '' }, allowClose: true, panes: [{ id: 'source-1', agent: 'claude', workspaceID: 'ws1', type: 'shell', workingDirectory: '/tmp/repo' }] });
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
    const api = makeFakeApi({ captures: { 'source-1': '' }, allowClose: true, panes: [{ id: 'source-1', agent: null, agentSessionID: sessionID, workspaceID: 'ws1', type: 'shell', workingDirectory: '/tmp/repo' }] });
    try {
        assert.deepEqual(await findTranscript(sessionID, null, { home }), { agent: 'codex', path: transcript });
        const result = await requestHandoff(api, { settings: {}, sessions: new Map() }, {}, { paneID: 'source-1' },
            { home, root: join(home, 'handoffs'), uuid: () => 'button', sleep: async () => {} });
        assert.equal(result.ok, true);
        assert.equal(result.toAgent, 'claude');
        assert.equal(result.sourceSessionID, sessionID);
        assert.equal(result.handoffPath, null);
        const command = api.callsTo('terminal.send')[0].args[1];
        assert.match(command, /&& claude /);
        assert.ok(command.includes(`Read the Codex session ${sessionID} from ${transcript}`));
        assert.doesNotMatch(command, /Swarm-it handoff|summarize|Next section|use the swarm-it skill/i);
        assert.equal(result.sourceClosed, true);
        assert.deepEqual(api.callsTo('panes.close')[0].args, ['source-1']);
    } finally { rmSync(home, { recursive: true, force: true }); }
});

test('pane header needs a session ID, and lets the target locate the transcript when no local file is found', async () => {
    const api = makeFakeApi({ captures: { 'source-1': '' }, allowClose: true, panes: [{ id: 'source-1', agent: 'codex', workspaceID: 'ws1', type: 'shell', workingDirectory: '/tmp/repo' }] });
    const noID = await requestHandoff(api, { sessions: new Map() }, {}, { paneID: 'source-1' });
    assert.equal(noID.code, 'NO_SESSION');
    assert.equal(api.callsTo('panes.split').length, 0);
    api.paneList[0].agentSessionID = '11111111-2222-4333-8444-555555555555';
    const home = mkdtempSync(join(tmpdir(), 'swarm-handoff-empty-'));
    try {
        const result = await requestHandoff(api, { sessions: new Map() }, {}, { paneID: 'source-1' }, { home, sleep: async () => {} });
        assert.equal(result.ok, true);
        assert.equal(result.handoffPath, null);
        assert.ok(api.callsTo('terminal.send')[0].args[1].includes(`Read the Codex session ${api.paneList[0].agentSessionID} and continue`));
        assert.equal(api.callsTo('panes.close').length, 1);
    } finally { rmSync(home, { recursive: true, force: true }); }
});

test('pane header finds a Claude transcript and starts Codex', async () => {
    const home = mkdtempSync(join(tmpdir(), 'swarm-handoff-claude-'));
    const sessionID = '11111111-2222-4333-8444-555555555555';
    const transcript = join(home, '.claude', 'projects', 'sample', `${sessionID}.jsonl`);
    mkdirSync(join(home, '.claude', 'projects', 'sample'), { recursive: true });
    writeFileSync(transcript, '{}\n');
    const api = makeFakeApi({ captures: { 'source-1': '' }, allowClose: true, panes: [{ id: 'source-1', agent: 'claude', agentSessionID: sessionID, workspaceID: 'ws1', type: 'shell', workingDirectory: '/tmp/repo' }] });
    try {
        assert.deepEqual(await findTranscript(sessionID, 'claude', { home }), { agent: 'claude', path: transcript });
        const result = await requestHandoff(api, { settings: {}, sessions: new Map() }, {}, { paneID: 'source-1' },
            { home, root: join(home, 'handoffs'), uuid: () => 'claude', sleep: async () => {} });
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
    const api = makeFakeApi({ captures: { 'source-1': '' }, allowClose: true, panes: [{ id: 'source-1', agent: 'codex', agentSessionID: sessionID, workspaceID: 'ws1', type: 'shell', workingDirectory: '/tmp/repo' }] });
    try {
        const result = await handoff(api, { settings: {} }, { ...summary, quitSource: true },
            { root, uuid: () => 'three', sleep: async () => {} });
        assert.equal(result.ok, true);
        assert.equal(result.sourceSessionID, sessionID);
        assert.equal(result.sourceCloseScheduled, false);
        assert.equal(result.sourceClosed, true);
        assert.equal(api.callsTo('panes.close').length, 1);
        assert.equal(result.handoffPath, null);
        assert.match(api.callsTo('terminal.send')[0].args[1], new RegExp(sessionID));
        assert.deepEqual(api.callsTo('panes.close')[0].args, ['source-1']);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('session-only handoff accepts a session ID without a summary and rejects mismatched IDs', async () => {
    const sessionID = '11111111-2222-4333-8444-555555555555';
    const args = { sourcePaneID: 'source-1', fromAgent: 'claude', toAgent: 'codex', sourceSessionID: sessionID };
    assert.equal(validateHandoff(args), null);
    assert.equal(validateHandoff({ ...args, sourceSessionID: 'bad; id' }).code, 'BAD_SESSION');
    const api = makeFakeApi({ captures: { 'source-1': '' }, allowClose: true, panes: [{ id: 'source-1', agent: 'claude', agentSessionID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', workingDirectory: '/tmp', workspaceID: 'ws1' }] });
    assert.equal((await handoff(api, { settings: {} }, args)).code, 'SESSION_MISMATCH');
    assert.equal(api.callsTo('panes.split').length, 0);
});

test('a failed target send leaves the source session open', async () => {
    const api = makeFakeApi({ captures: { 'source-1': '' }, allowClose: true, panes: [{ id: 'source-1', agent: 'claude', agentSessionID: '11111111-2222-4333-8444-555555555555', workingDirectory: '/tmp', workspaceID: 'ws1' }] });
    api.terminal.send = async () => { throw new Error('send failed'); };
    const result = await requestHandoff(api, { sessions: new Map() }, {}, { paneID: 'source-1' }, { sleep: async () => {} });
    assert.deepEqual(result, { ok: false, error: 'target pane opened but the agent did not start: send failed', code: 'SEND_FAILED', paneID: 'split-1', handoffPath: null });
    assert.equal(api.callsTo('panes.close').length, 0);
});

test('the helper transfers a session ID without reading a summary from stdin', () => {
    const root = mkdtempSync(join(tmpdir(), 'session-transfer-'));
    const sessionID = '11111111-2222-4333-8444-555555555555';
    const executable = join(root, 'kelpi');
    const payloadPath = join(root, 'payload.json');
    writeFileSync(executable, `#!${process.execPath}\nconst fs = require('node:fs'); const args = JSON.parse(process.argv.at(-1)); fs.writeFileSync(${JSON.stringify(payloadPath)}, JSON.stringify(args)); console.log(JSON.stringify({ok:true, toAgent:args.toAgent, paneID:'target-1', sourceSessionID:args.sourceSessionID, handoffPath:null, sourceClosed:true}));\n`);
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
        assert.ok(output.includes('source pane closed'));
    } finally { rmSync(root, { recursive: true, force: true }); }
});

const codexComposer = '› Ask Codex to do anything\nGPT-6.1-Sol low · ~/repos · Investigate Atlantis role assumption\n← for agents · ? for shortcuts';
const nativeSession = '22222222-3333-4444-8555-666666666666';
function missingCodexMetadata({ stale = false, draft = false, statusReply = true } = {}) {
    const api = makeFakeApi({ allowClose: true, panes: [{ id: 'source-1', type: 'shell', workspaceID: 'ws1', workingDirectory: '/tmp/repo', status: 'idle',
        ...(stale ? { agent: 'claude', agentSessionID: '11111111-2222-4333-8444-555555555555' } : {}) }], captures: { 'source-1': draft ? codexComposer.replace('Ask Codex to do anything', 'my unsent draft') : codexComposer } });
    const send = api.terminal.send;
    api.terminal.send = async (id, text, options) => {
        const result = await send(id, text, options);
        if (text === '/status' && statusReply) api.captureStore['source-1'] = `Session: ${nativeSession}\n${codexComposer}`;
        return result;
    };
    return api;
}

test('Codex handoff reads the visible conversation when hooks are missing or report an old Claude session', async () => {
    for (const stale of [false, true]) {
        const api = missingCodexMetadata({ stale });
        const result = await requestHandoff(api, { sessions: new Map() }, {}, { paneID: 'source-1' }, { sleep: async () => {} });
        assert.equal(result.ok, true);
        assert.equal(result.fromAgent, 'codex'); assert.equal(result.toAgent, 'claude');
        assert.equal(result.sourceSessionID, nativeSession);
        assert.equal(api.callsTo('terminal.send')[0].args[1], '/status');
        const command = api.callsTo('terminal.send').at(-1).args[1];
        assert.ok(command.includes(`Read the Codex session ${nativeSession}`));
        assert.ok(command.includes("export KELPI_PANE_ID='split-1'"));
        assert.equal(result.sourceClosed, true); assert.equal(api.callsTo('panes.close').length, 1);
    }
});

test('Codex handoff preserves a draft or a session that cannot be identified', async () => {
    for (const draft of [false, true]) {
        const api = missingCodexMetadata({ draft, statusReply: false });
        const before = api.captureStore['source-1'];
        const result = await requestHandoff(api, { sessions: new Map() }, {}, { paneID: 'source-1' }, { sleep: async () => {} });
        assert.deepEqual(result, draft
            ? { ok: false, error: "Codex's input box has text in it; clear it first", code: 'INPUT_NOT_EMPTY' }
            : { ok: false, error: 'Codex did not report its session ID through /status; it was left open', code: 'NO_SESSION' });
        assert.equal(api.captureStore['source-1'], before);
        assert.deepEqual(api.callsTo('terminal.send').map(c => c.args[1]), draft ? [] : ['/status']);
        assert.equal(api.callsTo('panes.split').length, 0); assert.equal(api.callsTo('panes.close').length, 0);
    }
});

test('Claude to Codex handoff sets the destination pane in Codex tool environments', async () => {
    const api = makeFakeApi({ captures: { 'source-1': '' }, allowClose: true, panes: [{ id: 'source-1', type: 'shell', agent: 'claude', agentSessionID: nativeSession, workspaceID: 'ws1', workingDirectory: '/tmp' }] });
    const result = await requestHandoff(api, { sessions: new Map() }, {}, { paneID: 'source-1' }, { sleep: async () => {} });
    assert.equal(result.ok, true);
    const command = api.callsTo('terminal.send')[0].args[1];
    assert.ok(command.includes("export KELPI_PANE_ID='split-1'"));
    assert.ok(command.includes('shell_environment_policy.set.KELPI_PANE_ID="split-1"'));
    assert.equal(api.callsTo('panes.close').length, 1);
});


test('handoff commands run each destination CLI with the new pane ID instead of inherited stale identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'handoff-env-'));
    const output = join(root, 'started.json');
    try {
        for (const target of ['claude', 'codex']) {
            const stub = join(root, target);
            writeFileSync(stub, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({pane:process.env.KELPI_PANE_ID,args:process.argv.slice(2)}));\n`);
            chmodSync(stub, 0o700);
            const api = makeFakeApi({ panes: [{ id: 'source-1', type: 'shell', agent: target === 'claude' ? 'codex' : 'claude', workingDirectory: root, workspaceID: 'ws1' }] });
            const result = await handoff(api, { settings: {} }, { ...summary, fromAgent: target === 'claude' ? 'codex' : 'claude', toAgent: target, sourceSessionID: nativeSession });
            assert.equal(result.ok, true);
            const command = api.callsTo('terminal.send')[0].args[1];
            execFileSync('/bin/zsh', ['-f', '-c', command], { env: { ...process.env, PATH: `${root}${delimiter}${process.env.PATH}`, KELPI_PANE_ID: 'closed-source-pane' }, timeout: 5000 });
            const launched = JSON.parse(readFileSync(output, 'utf8'));
            assert.equal(launched.pane, 'split-1');
            assert.ok(launched.args.at(-1).includes(nativeSession));
            if (target === 'codex') assert.deepEqual(launched.args.slice(0, 2), ['-c', 'shell_environment_policy.set.KELPI_PANE_ID="split-1"']);
            else assert.equal(launched.args.length, 1);
        }
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('source close finishes inside the handoff invocation, before success is returned', async () => {
    const api = makeFakeApi({ allowClose: true, panes: [{ id: 'source-1', agent: 'codex', type: 'shell', workingDirectory: '/tmp', workspaceID: 'ws1' }] });
    const result = await handoff(api, { settings: {} }, { ...summary, sourceSessionID: nativeSession, quitSource: true }, { sleep: async () => {}, scheduleClose: () => {} });
    assert.equal(result.sourceClosed, true);
    assert.equal(result.sourceCloseScheduled, false);
    assert.deepEqual(api.callsTo('panes.close').map(c => c.args), [['source-1']]);
    assert.equal(api.callsTo('terminal.send').length, 1);
});

test('a refused source close reports the open destination instead of silently claiming success', async () => {
    const api = makeFakeApi({ allowClose: true, closeFails: true, panes: [{ id: 'source-1', agent: 'codex', type: 'shell', workingDirectory: '/tmp', workspaceID: 'ws1' }] });
    const result = await handoff(api, { settings: {} }, { ...summary, sourceSessionID: nativeSession, quitSource: true }, { sleep: async () => {}, scheduleClose: () => {} });
    assert.deepEqual(result, { ok: false, code: 'CLOSE_FAILED', error: 'claude opened, but the source pane could not close: host refused', paneID: 'split-1', sourceSessionID: nativeSession, handoffPath: null });
    assert.equal(api.callsTo('panes.split').length, 1);
    assert.equal(api.callsTo('terminal.send').length, 1);
    assert.deepEqual(api.callsTo('panes.close').map(c => c.args), [['source-1']]);
});

test('an idle Codex handoff ignores stale Claude running metadata', async () => {
    const api = missingCodexMetadata({ stale: true });
    api.paneList[0].status = 'running';
    const result = await requestHandoff(api, { sessions: new Map() }, {}, { paneID: 'source-1' }, { sleep: async () => {} });
    assert.equal(result.ok, true);
    assert.equal(result.fromAgent, 'codex'); assert.equal(result.sourceSessionID, nativeSession);
    assert.equal(result.sourceClosed, true);
    assert.equal(api.callsTo('terminal.send')[0].args[1], '/status');
    assert.deepEqual(api.callsTo('panes.close').map(c => c.args), [['source-1']]);
});

test('a live working Codex is never handed off even when pane metadata says idle', async () => {
    const api = missingCodexMetadata();
    api.captureStore['source-1'] = `• Working (2m • esc to interrupt)\n${codexComposer}`;
    const result = await requestHandoff(api, { sessions: new Map() }, {}, { paneID: 'source-1' }, { sleep: async () => {} });
    assert.deepEqual(result, { ok: false, error: 'Codex is mid-reply; wait for it to finish', code: 'BUSY' });
    assert.deepEqual(api.callsTo('terminal.send'), []);
    assert.deepEqual(api.callsTo('panes.split'), []); assert.deepEqual(api.callsTo('panes.close'), []);
});
