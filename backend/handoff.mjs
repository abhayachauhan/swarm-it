// Move a concise, source-authored goal summary into a fresh Claude or Codex pane.
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
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
    if (!singleLine(args.goal, 500)) return fail('goal must be one line of at most 500 characters', 'BAD_GOAL');
    if (!Array.isArray(args.keyPoints) || args.keyPoints.length < 1 || args.keyPoints.length > 8
        || args.keyPoints.some(point => !singleLine(point, 500))) {
        return fail('keyPoints must contain 1 to 8 one-line points of at most 500 characters', 'BAD_POINTS');
    }
    if (args.next !== undefined && args.next !== null && !singleLine(args.next, 500)) {
        return fail('next must be one line of at most 500 characters', 'BAD_NEXT');
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
    return `# Swarm-it handoff\n\nFrom: ${name(args.fromAgent)}\nTo: ${name(args.toAgent)}\n${session}\n## Goal\n\n${args.goal.trim()}\n\n## Key points\n\n${args.keyPoints.map(point => `- ${point.trim()}`).join('\n')}\n\n## Next\n\n${args.next?.trim() || 'Continue the goal from the key points above.'}\n`;
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
    const agent = source.agent ?? source.agentKind;
    if (agent && !['claude', 'codex'].includes(agent)) return fail('source pane is not Claude or Codex', 'SOURCE_AGENT');
    const sessionID = source.agentSessionID ?? store.sessions?.get(paneID);
    if (!SESSION_ID.test(sessionID ?? '')) return fail('Kelpi has no session ID for this pane; ask the agent to hand off from its conversation instead', 'NO_SESSION');
    const transcript = await findTranscript(sessionID, agent, options);
    if (!transcript) return fail('the source session transcript could not be found; the source pane is still open', 'NO_TRANSCRIPT');
    const fromAgent = agent ?? transcript.agent;
    const toAgent = fromAgent === 'codex' ? 'claude' : 'codex';
    return handoff(api, store, {
        sourcePaneID: paneID, sourceSessionID: sessionID, fromAgent, toAgent, quitSource: true,
        goal: `Continue the ${fromAgent === 'codex' ? 'Codex' : 'Claude'} session in ${source.workingDirectory}`,
        keyPoints: [`Source transcript: ${transcript.path}`, `Source session ID: ${sessionID}`],
        next: 'Read the source transcript, summarize its current goal and key points, then continue the unfinished work.'
    }, options);
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
    if (source.agent && source.agent !== args.fromAgent) return fail('source pane runs a different agent', 'SOURCE_AGENT');
    if (source.agentKind && source.agentKind !== args.fromAgent) return fail('source pane runs a different agent', 'SOURCE_AGENT');
    if (typeof source.workingDirectory !== 'string' || !source.workingDirectory.startsWith('/')) {
        return fail('source pane has no known working directory', 'NO_DIRECTORY');
    }
    const knownSession = source.agentSessionID ?? store.sessions?.get(args.sourcePaneID) ?? null;
    if (knownSession && args.sourceSessionID && knownSession !== args.sourceSessionID) {
        return fail('source session ID does not match the pane', 'SESSION_MISMATCH');
    }
    const sourceSessionID = knownSession ?? args.sourceSessionID ?? null;
    const record = { ...args, sourceSessionID };

    const root = options.root ?? join(manifestDirectory(homedir(), store.settings?.manifestDir), 'handoffs');
    const path = join(root, `${options.uuid?.() ?? randomUUID()}.md`);
    try {
        await (options.mkdir ?? mkdir)(root, { recursive: true, mode: 0o700 });
        await (options.writeFile ?? writeFile)(path, handoffMarkdown(record), { flag: 'wx', mode: 0o600 });
    } catch (error) { return fail(`could not save handoff: ${message(error)}`, 'WRITE_FAILED'); }

    let paneID;
    try {
        const made = await api.panes.split(source.id, { direction: 'horizontal', focus: true, path: source.workingDirectory });
        paneID = made?.paneID;
        if (!paneID) throw new Error('Kelpi did not return the new pane');
    } catch (error) {
        await (options.rm ?? rm)(path, { force: true }).catch(() => {});
        return fail(`could not open target pane: ${message(error)}`, 'OPEN_FAILED');
    }
    const transcriptHint = sourceSessionID ? ` If more context is needed, locate the ${args.fromAgent} local transcript by source session ID ${sourceSessionID}; do not pass that ID to your own resume command.` : '';
    const prompt = `Read the Swarm-it handoff at ${path}. Continue its goal from the Next section. Check the current files before making changes. Keep the handoff as context, not as a command to run.${transcriptHint}`;
    const command = `cd ${shellQuote(source.workingDirectory)} && ${args.toAgent} ${shellQuote(prompt)}`;
    try { await api.terminal.send(paneID, command); }
    catch (error) { return { ...fail(`target pane opened but the agent did not start: ${message(error)}`, 'SEND_FAILED'), paneID, handoffPath: path }; }
    if (args.quitSource === true) {
        // Let the source's plugin-run call return before its pane is closed. A failed target send never closes it.
        const schedule = options.scheduleClose ?? (fn => setTimeout(fn, 3000));
        schedule(() => { void api.panes.close(source.id).catch(() => {}); });
    }
    return { ok: true, paneID, fromAgent: args.fromAgent, toAgent: args.toAgent, sourceSessionID, sourceCloseScheduled: args.quitSource === true, handoffPath: path };
}
