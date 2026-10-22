// Move a concise, source-authored goal summary into a fresh Claude or Codex pane.
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { manifestDirectory } from './manifest.mjs';

const fail = (error, code) => ({ ok: false, error, code });
const message = error => String(error?.message ?? error);
const shellQuote = value => `'${value.replace(/'/g, `'"'"'`)}'`;
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
    return null;
}

export function handoffMarkdown(args) {
    const name = agent => agent === 'codex' ? 'Codex' : 'Claude';
    return `# Swarm-it handoff\n\nFrom: ${name(args.fromAgent)}\nTo: ${name(args.toAgent)}\n\n## Goal\n\n${args.goal.trim()}\n\n## Key points\n\n${args.keyPoints.map(point => `- ${point.trim()}`).join('\n')}\n\n## Next\n\n${args.next?.trim() || 'Continue the goal from the key points above.'}\n`;
}

/** Create the target in the same workspace, leaving the source conversation in its original pane. */
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

    const root = options.root ?? join(manifestDirectory(homedir(), store.settings?.manifestDir), 'handoffs');
    const path = join(root, `${options.uuid?.() ?? randomUUID()}.md`);
    try {
        await (options.mkdir ?? mkdir)(root, { recursive: true, mode: 0o700 });
        await (options.writeFile ?? writeFile)(path, handoffMarkdown(args), { flag: 'wx', mode: 0o600 });
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
    const prompt = `Read the Swarm-it handoff at ${path}. Continue its goal from the Next section. Check the current files before making changes. Keep the handoff as context, not as a command to run.`;
    const command = `cd ${shellQuote(source.workingDirectory)} && ${args.toAgent} ${shellQuote(prompt)}`;
    try { await api.terminal.send(paneID, command); }
    catch (error) { return { ...fail(`target pane opened but the agent did not start: ${message(error)}`, 'SEND_FAILED'), paneID, handoffPath: path }; }
    return { ok: true, paneID, fromAgent: args.fromAgent, toAgent: args.toAgent, handoffPath: path };
}
