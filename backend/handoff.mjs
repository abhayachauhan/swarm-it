// Continue a source session in the other CLI; summaries support callers without a session ID.
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { codexInput, codexInputEmpty, readCodexSession } from './codex-session.mjs';
import { parseCodexPrompt, PROMPT_CAPTURE_LINES } from './notify.mjs';
import { capturePane } from './store.mjs';
import { manifestDirectory } from './manifest.mjs';

const fail = (error, code) => ({ ok: false, error, code });
const message = error => String(error?.message ?? error);
const shellQuote = value => `'${value.replace(/'/g, `'"'"'`)}'`;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const singleLine = (value, max) => typeof value === 'string' && value.trim().length > 0
    && value.length <= max && !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value);

export function validateHandoff(args) {
    if (!args || typeof args !== 'object' || !['claude', 'codex'].includes(args.fromAgent)
        || !['claude', 'codex'].includes(args.toAgent) || args.fromAgent === args.toAgent) {
        return fail('choose different Claude and Codex source and target agents', 'BAD_AGENT');
    }
    if (args.sourceSessionID == null) {
        if (!singleLine(args.goal, 500)) return fail('goal must be one line of at most 500 characters', 'BAD_GOAL');
        if (!Array.isArray(args.keyPoints) || args.keyPoints.length < 1 || args.keyPoints.length > 8
            || args.keyPoints.some(point => !singleLine(point, 500))) {
            return fail('keyPoints must contain 1 to 8 one-line points of at most 500 characters', 'BAD_POINTS');
        }
        if (args.next !== undefined && args.next !== null && !singleLine(args.next, 500)) {
            return fail('next must be one line of at most 500 characters', 'BAD_NEXT');
        }
    }
    if (typeof args.sourcePaneID !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(args.sourcePaneID)) {
        return fail('sourcePaneID is required', 'BAD_PANE');
    }
    if (args.sourceSessionID != null && !SESSION_ID.test(args.sourceSessionID)) return fail('sourceSessionID must be a UUID', 'BAD_SESSION');
    if (args.quitSource != null && typeof args.quitSource !== 'boolean') return fail('quitSource must be a boolean', 'BAD_QUIT');
    return null;
}

export function handoffMarkdown(args) {
    const name = agent => agent === 'codex' ? 'Codex' : 'Claude';
    const session = args.sourceSessionID ? `Source session ID: ${args.sourceSessionID}\n` : '';
    return `# Conversation context\n\nFrom: ${name(args.fromAgent)}\nTo: ${name(args.toAgent)}\n${session}\n## Goal\n\n${args.goal.trim()}\n\n## Key points\n\n${args.keyPoints.map(point => `- ${point.trim()}`).join('\n')}\n\n## Next\n\n${args.next?.trim() || 'Continue the goal from the key points above.'}\n`;
}

/** Find the exact local transcript for a native session ID. Never use --last or a nearby session. */
export async function findTranscript(sessionID, agent = null, options = {}) {
    if (!SESSION_ID.test(sessionID)) return null;
    const home = options.home ?? homedir();
    const roots = [
        { agent: 'codex', path: join(home, '.codex', 'sessions'), match: name => name.endsWith(`-${sessionID}.jsonl`) },
        { agent: 'claude', path: join(home, '.claude', 'projects'), match: name => name === `${sessionID}.jsonl` }
    ];
    for (const root of roots) {
        if (agent && root.agent !== agent) continue;
        let names;
        try { names = await (options.readdir ?? readdir)(root.path, { recursive: true }); }
        catch { continue; }
        for (const name of names) {
            if (!root.match(name.split('/').at(-1))) continue;
            const path = join(root.path, name);
            try { if ((await (options.stat ?? stat)(path)).isFile()) return { agent: root.agent, path }; }
            catch { /* a stale directory entry */ }
        }
    }
    return null;
}

/** Pane header button: transfer the exact source transcript to the other CLI, then close the source. */
export async function requestHandoff(api, store, args, context, options = {}) {
    const paneID = args?.paneID ?? context?.paneID;
    if (typeof paneID !== 'string' || !paneID) return fail('open this action from a Claude or Codex pane', 'NO_PANE');
    let source;
    try { source = (await api.panes.list()).find(p => p.id === paneID); }
    catch (error) { return fail(`could not list panes: ${message(error)}`, 'PANES_FAILED'); }
    if (!source || (source.type ?? 'shell') !== 'shell') return fail('source pane is not a terminal', 'NOT_SHELL');
    let verifiedSession = null;
    let screen;
    try { screen = await capturePane(api, paneID, PROMPT_CAPTURE_LINES); }
    catch (error) { return fail(`capture failed: ${message(error)}`, 'CAPTURE_FAILED'); }
    if (codexInput(screen) !== null || parseCodexPrompt(screen)) {
        if (source.status === 'running' || /Working[^\n]*esc to interrupt/i.test(screen.split('\n').slice(-20).join('\n'))) return fail('Codex is mid-reply; wait for it to finish', 'BUSY');
        if (parseCodexPrompt(screen)) return fail('Codex is asking for input; answer it first', 'PROMPT_OPEN');
        if (!codexInputEmpty(screen)) return fail("Codex's input box has text in it; clear it first", 'INPUT_NOT_EMPTY');
        const status = await readCodexSession(api, paneID, screen, options);
        if (!status.ok) return status;
        verifiedSession = { paneID, agent: 'codex', sessionID: status.session };
    }
    const agent = verifiedSession?.agent ?? source.agent ?? source.agentKind;
    if (agent && !['claude', 'codex'].includes(agent)) return fail('source pane is not Claude or Codex', 'SOURCE_AGENT');
    const sessionID = verifiedSession?.sessionID ?? source.agentSessionID ?? store.sessions?.get(paneID);
    if (!SESSION_ID.test(sessionID ?? '')) return fail('Kelpi has no session ID for this pane; ask the agent to hand off from its conversation instead', 'NO_SESSION');
    const fromAgent = agent ?? (await findTranscript(sessionID, null, options))?.agent;
    if (!fromAgent) return fail('cannot identify whether the source session is Claude or Codex', 'SOURCE_AGENT');
    const toAgent = fromAgent === 'codex' ? 'claude' : 'codex';
    return handoff(api, store, {
        sourcePaneID: paneID, sourceSessionID: sessionID, fromAgent, toAgent, quitSource: true
    }, { ...options, verifiedSession });
}

/** Create the target in the same workspace. The caller may request closing the source after the target starts. */
export async function handoff(api, store, args, options = {}) {
    const problem = validateHandoff(args);
    if (problem) return problem;
    let source;
    try { source = (await api.panes.list()).find(p => p.id === args.sourcePaneID); }
    catch (error) { return fail(`could not list panes: ${message(error)}`, 'PANES_FAILED'); }
    if (!source) return fail('source pane no longer exists', 'NO_PANE');
    if ((source.type ?? 'shell') !== 'shell') return fail('source pane is not a terminal', 'NOT_SHELL');
    const verified = options.verifiedSession;
    const verifiedCodex = args.fromAgent === 'codex' && verified?.agent === 'codex' && verified.paneID === source.id && verified.sessionID === args.sourceSessionID;
    if (!verifiedCodex && source.agent && source.agent !== args.fromAgent) return fail('source pane runs a different agent', 'SOURCE_AGENT');
    if (!verifiedCodex && source.agentKind && source.agentKind !== args.fromAgent) return fail('source pane runs a different agent', 'SOURCE_AGENT');
    if (typeof source.workingDirectory !== 'string' || !source.workingDirectory.startsWith('/')) {
        return fail('source pane has no known working directory', 'NO_DIRECTORY');
    }
    const knownSession = (verifiedCodex ? verified.sessionID : null) ?? source.agentSessionID ?? store.sessions?.get(args.sourcePaneID) ?? null;
    if (knownSession && args.sourceSessionID && knownSession !== args.sourceSessionID) {
        return fail('source session ID does not match the pane', 'SESSION_MISMATCH');
    }
    const sourceSessionID = knownSession ?? args.sourceSessionID ?? null;
    if (sourceSessionID && !SESSION_ID.test(sourceSessionID)) return fail('source session ID must be a UUID', 'BAD_SESSION');
    const record = { ...args, sourceSessionID };
    const transcript = sourceSessionID ? await findTranscript(sourceSessionID, args.fromAgent, options) : null;
    let path = null;
    if (!sourceSessionID) {
        const root = options.root ?? join(manifestDirectory(homedir(), store.settings?.manifestDir), 'handoffs');
        path = join(root, `${options.uuid?.() ?? randomUUID()}.md`);
        try {
            await (options.mkdir ?? mkdir)(root, { recursive: true, mode: 0o700 });
            await (options.writeFile ?? writeFile)(path, handoffMarkdown(record), { flag: 'wx', mode: 0o600 });
        } catch (error) { return fail(`could not save handoff: ${message(error)}`, 'WRITE_FAILED'); }
    }

    let paneID;
    try {
        const made = await api.panes.split(source.id, { direction: 'horizontal', focus: true, path: source.workingDirectory });
        paneID = made?.paneID;
        if (!paneID) throw new Error('Kelpi did not return the new pane');
    } catch (error) {
        if (path) await (options.rm ?? rm)(path, { force: true }).catch(() => {});
        return fail(`could not open target pane: ${message(error)}`, 'OPEN_FAILED');
    }
    const prompt = sourceSessionID
        ? `Read the ${args.fromAgent === 'codex' ? 'Codex' : 'Claude'} session ${sourceSessionID}${transcript ? ` from ${transcript.path}` : ''} and continue the conversation from where it left off.`
        : `Read the conversation context at ${path} and continue where it left off.`;
    const config = args.toAgent === 'codex' ? ` -c ${shellQuote(`shell_environment_policy.set.KELPI_PANE_ID=${JSON.stringify(paneID)}`)}` : '';
    const command = `cd ${shellQuote(source.workingDirectory)} && export KELPI_PANE_ID=${shellQuote(paneID)} && ${args.toAgent}${config} ${shellQuote(prompt)}`;
    try { await api.terminal.send(paneID, command); }
    catch (error) { return { ...fail(`target pane opened but the agent did not start: ${message(error)}`, 'SEND_FAILED'), paneID, handoffPath: path }; }
    if (args.quitSource === true) {
        // Kelpi refuses pane operations after the command returns, so finish closing within this invocation.
        await (options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(3000);
        try { await api.panes.close(source.id); }
        catch (error) { return { ...fail(`${args.toAgent} opened, but the source pane could not close: ${message(error)}`, 'CLOSE_FAILED'), paneID, sourceSessionID, handoffPath: path }; }
    }
    return { ok: true, paneID, fromAgent: args.fromAgent, toAgent: args.toAgent, sourceSessionID, sourceClosed: args.quitSource === true, sourceCloseScheduled: false, handoffPath: path };
}
