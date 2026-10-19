// "Run last suggested command": find the last shell command Claude Code suggested in a pane capture and undo the
// line wraps Claude Code drew itself (a real newline plus the block's indent and two more spaces).
// The parsing is pure; the pane helpers at the end take the injected `api`. Nothing here types into a pane unless
// the run view's Run button sent `confirmed: true`.
import { spawn } from 'node:child_process';
import { textProblem } from './actions.mjs';
import { CAPTURE_TIMEOUT_MS } from './store.mjs';
import { withTimeout } from './safepath.mjs';

/** Lines of scrollback read from the pane. */
export const SUGGESTED_CAPTURE_LINES = 200;

const width = line => [...line].length;
const lead = line => line.length - line.trimStart().length;
// Claude Code draws its input box with full-width rules; their length is the pane width.
const RULE = /^\s*[─━═╌┄]{20,}\s*$/;
const BANG = /^(\s*(?:[⏺●]\s+)?)! (\S.*)$/;
const FENCE_OPEN = /^(\s*)```\s*(?:bash|sh|shell|zsh)?\s*$/;
const FENCE_CLOSE = /^\s*```\s*$/;
const RUN = /^(\s*(?:[⏺●]\s+)?)Run\b/;
// A paragraph of reply text that is a command: it starts with a common CLI and reads like shell (a flag, pipe,
// redirect or quote), so prose that merely starts with "git" or "make" is left alone.
const CLI = '(?:sudo\\s+)?(?:curl|wget|ssh|scp|rsync|git|gh|kubectl|helm|aws|terraform|docker|npm|npx|yarn|pnpm|node|python3?|pip3?|uv|brew|make|ls|cat|grep|rg|jq|kelpi|claude|mryum|tilt|psql|pup|open)\\s';
const BARE = new RegExp(`^\\s*${CLI}`);
// `! <command>` inside a sentence ("Log in again with ! aws sso login --profile x. Then ..."): it runs to the sentence end.
const INLINE = new RegExp(`\\s! (${CLI}.*)$`);
const SENTENCE_END = /[.;](?=\s+[A-Z(])|,(?=\s+(?:then|and|or|which)\b)|[.,;:]?\s*$/;
const SHELLISH = /\s--?\w|[|<>]|['"]/;
const lastToken = line => line.trimEnd().split(/\s+/).at(-1) ?? '';
const firstToken = line => line.trim().split(/\s+/)[0] ?? '';

/** The pane width the capture shows (its widest rule line), or 0 when there is none. */
export function wrapWidth(lines) {
    return lines.filter(line => RULE.test(line)).reduce((max, line) => Math.max(max, width(line.trimEnd())), 0);
}

/**
 * Rejoin a block's lines. A line indented by exactly `indent + 2` continues the line before it (unless that one ends
 * with a shell `\`); any other line starts a new command. The break was at a space (keep one space) unless the line
 * before ended without a space AND filled the wrap width, which means the wrap split a token (join with nothing).
 * Unknown width (0) never counts as filled, so the join is a space.
 */
export function joinWraps(lines, indent, wrap = 0) {
    const commands = [];
    let previous = null;
    for (const line of lines) {
        if (!line.trim()) { previous = null; continue; }
        const current = commands.length ? commands[commands.length - 1] : null;
        if (previous !== null && current !== null && lead(line) === indent + 2 && !current.trimEnd().endsWith('\\')) {
            // Claude Code breaks at spaces and splits only a word too long for the line, so a filled line is a
            // mid-token break only when the two halves together are a long word.
            const filled = wrap > 0 && width(previous) >= wrap - 1 && width(lastToken(previous) + firstToken(line)) > wrap / 2;
            const separator = !previous.endsWith(' ') && filled ? '' : ' ';
            commands[commands.length - 1] = current.trimEnd() + separator + line.trim();
        } else {
            commands.push(line.slice(Math.min(lead(line), indent)).trimEnd());
        }
        previous = line;
    }
    return commands.join('\n');
}

/** Lines after `from` that continue a one-line command at `indent` (indented by exactly indent + 2). */
function continuation(lines, from, indent) {
    let end = from + 1;
    while (end < lines.length && lines[end].trim() && lead(lines[end]) === indent + 2) end += 1;
    return end;
}

/**
 * Lines after `from` that continue a `! ` command at `indent`. Claude Code wraps them under the text after `! `
 * (indent + 2) or, in reply text, back at the `!` column itself; another `! ` line or a fence there is a new block.
 */
function bangContinuation(lines, from, indent) {
    let end = from + 1;
    while (end < lines.length && lines[end].trim()
        && (lead(lines[end]) === indent + 2 || (lead(lines[end]) === indent && !BANG.test(lines[end]) && !FENCE_OPEN.test(lines[end])))) end += 1;
    return end;
}

/** Every suggested command block in the capture, in order: `{ start, kind, command }`. */
function candidates(lines, wrap) {
    const found = [];
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const bang = BANG.exec(line);
        if (bang) {
            // The block's indent is the column of `!`. Wraps at that column are re-indented by two so joinWraps sees them.
            const indent = width(bang[1]);
            const end = bangContinuation(lines, i, indent);
            const wraps = lines.slice(i + 1, end).map(l => (lead(l) === indent ? '  ' + l : l));
            // `! ` becomes two spaces, so the width check still sees the line as wide as it was drawn.
            const block = [' '.repeat(indent + 2) + bang[2], ...wraps];
            found.push({ start: i, kind: 'bang', command: joinWraps(block, indent, wrap).trim() });
            i = end - 1;
            continue;
        }
        const fence = FENCE_OPEN.exec(line);
        if (fence) {
            let close = i + 1;
            while (close < lines.length && !FENCE_CLOSE.test(lines[close])) close += 1;
            if (close >= lines.length) break; // still being written
            const body = lines.slice(i + 1, close);
            const filled = body.filter(l => l.trim());
            if (filled.length) {
                const indent = Math.min(...filled.map(lead));
                found.push({ start: i, kind: 'fence', command: joinWraps(body, indent, wrap) });
            }
            i = close;
            continue;
        }
        const run = RUN.exec(line);
        if (run) {
            const textIndent = width(run[1]);
            let next = i + 1;
            if (next < lines.length && !lines[next].trim()) next += 1; // one blank line allowed
            if (next < lines.length && lines[next].trim() && lead(lines[next]) > textIndent && !BANG.test(lines[next]) && !FENCE_OPEN.test(lines[next])) {
                const indent = lead(lines[next]);
                const end = continuation(lines, next, indent);
                found.push({ start: next, kind: 'run', command: joinWraps(lines.slice(next, end), indent, wrap) });
                i = end - 1;
                continue;
            }
        }
        const inline = INLINE.exec(line);
        if (inline) {
            // The sentence may wrap onto lines indented two deeper (a bullet's text); join them, then cut at its end.
            const end = continuation(lines, i, lead(line));
            const text = joinWraps([' '.repeat(lead(line) + 2) + inline[1], ...lines.slice(i + 1, end)], lead(line), wrap).trim();
            const command = text.slice(0, text.search(SENTENCE_END)).trim();
            if (command && !command.includes('\n')) found.push({ start: i, kind: 'inline', command });
            continue;
        }
        if (BARE.test(line) && (i === 0 || !lines[i - 1].trim())) {
            // A paragraph: its wraps sit at its own indent (or two deeper) and a blank line ends it.
            const indent = lead(line);
            const end = bangContinuation(lines, i, indent);
            const block = [' '.repeat(indent + 2) + line.trim(), ...lines.slice(i + 1, end).map(l => (lead(l) === indent ? '  ' + l : l))];
            const command = joinWraps(block, indent, wrap).trim();
            if (SHELLISH.test(command) && !command.includes('\n')) found.push({ start: i, kind: 'bare', command });
            i = end - 1;
        }
    }
    return found;
}

/**
 * The last command Claude Code suggested in `captureText`, rejoined, or null.
 * `options.cols` overrides the wrap width read from the capture.
 * @returns {{ command: string, kind: 'bang' | 'fence' | 'run' | 'bare' | 'inline' } | null}
 */
export function findSuggested(captureText, options = {}) {
    const lines = String(captureText ?? '').replace(/\r/g, '').split('\n');
    const wrap = Number.isFinite(options.cols) && options.cols > 0 ? options.cols : wrapWidth(lines);
    const all = candidates(lines, wrap).filter(c => c.command.trim());
    if (!all.length) return null;
    const last = all[all.length - 1];
    return { command: last.command, kind: last.kind };
}

/** Why `text` may not be typed into a shell, or null. Same text policy as everything else this plugin types. */
export function commandProblem(text) {
    if (typeof text !== 'string' || !text.trim()) return 'the command is empty';
    // Invisible format characters (bidi overrides, zero-width) could make the text shown differ from what runs.
    if (/\p{Cf}/u.test(text)) return 'text contains an invisible formatting character';
    return textProblem(text);
}

const fail = (error, code) => ({ ok: false, error, ...(code ? { code } : {}) });
const message = error => String(error?.message ?? error);
const isAgent = pane => !!(pane?.agent || pane?.agentSessionID);

/** The pane a command was invoked on: `args.paneID`, else the invocation context's pane, else the focused pane. */
export async function sourcePane(api, args, context) {
    const panes = await api.panes.list();
    const wanted = [args.paneID, context?.paneID].find(id => typeof id === 'string' && id);
    const pane = wanted
        ? panes.find(p => p.id === wanted)
        : panes.find(p => p.isFocused && p.isActiveWorkspace) ?? panes.find(p => p.isFocused);
    return pane ? { pane, panes } : { panes, error: fail(wanted ? `no pane ${wanted}` : 'no pane is focused', 'NO_PANE') };
}

/** Capture the pane's last SUGGESTED_CAPTURE_LINES lines and find the suggestion. */
export async function suggestionIn(api, paneID) {
    let captured;
    try {
        captured = await withTimeout(Promise.resolve().then(() => api.terminal.capture(paneID, { lines: SUGGESTED_CAPTURE_LINES, scrollback: true })), CAPTURE_TIMEOUT_MS, `capturing pane ${paneID}`);
    } catch (error) {
        return fail(`capture failed: ${message(error)}`, 'CAPTURE_FAILED');
    }
    const found = findSuggested(captured);
    return found ? { ok: true, ...found } : fail('no suggested command found in this pane', 'NO_COMMAND');
}

/** Panes the run view offers besides "a new shell pane": shells in the source pane's workspace, agents marked. */
export function runTargets(panes, source, exclude = []) {
    return panes
        .filter(p => p.workspaceID === source.workspaceID && (p.type ?? 'shell') === 'shell' && !exclude.includes(p.id))
        .map(p => ({ paneID: p.id, name: p.label || p.title || p.id, agent: isAgent(p), source: p.id === source.id }));
}

/**
 * Where Run points first: Claude's own session, so the output lands in the conversation, when the pane is a Claude
 * that is not mid-reply and the command is one line. Otherwise a new shell pane.
 * Kelpi keeps a pane "running" after the turn ends while background shells or agents run; it reports those as
 * `backgroundTasks`, so running with background tasks is a Claude at its prompt.
 */
export function defaultTarget(found, source) {
    const oneLine = typeof found?.command === 'string' && !found.command.trim().includes('\n');
    const midReply = source?.status === 'running' && !(source.backgroundTasks > 0);
    return oneLine && isAgent(source) && !midReply ? source.id : 'new';
}

/** Text typed into an agent pane runs as Claude Code's `!` shell command, so its output lands in the session. */
const asBang = text => (text.trimStart().startsWith('!') ? text.trim() : `! ${text.trim()}`);

/**
 * Type a confirmed command. `target` is 'new' (a shell split next to the source pane, in its directory) or a pane id;
 * a pane running an agent is refused unless the user picked it (`allowAgent: true`), and gets the text as one `!` line.
 */
export async function runConfirmed(api, args) {
    if (args.confirmed !== true) return fail('the command runs only after the user confirms it', 'NOT_CONFIRMED');
    const problem = commandProblem(args.text);
    if (problem) return fail(problem, 'BAD_TEXT');
    if (typeof args.sourcePaneID !== 'string' || !args.sourcePaneID) return fail('sourcePaneID is required', 'BAD_ARGS');
    const panes = await api.panes.list();
    const source = panes.find(p => p.id === args.sourcePaneID);
    let paneID;
    let text = args.text;
    if (args.target === 'new' || args.target === undefined) {
        if (!source) return fail(`no pane ${args.sourcePaneID}`, 'NO_PANE');
        try {
            const made = await api.panes.split(source.id, { direction: 'horizontal', focus: true, ...(source.workingDirectory ? { path: source.workingDirectory } : {}) });
            paneID = made?.paneID;
        } catch (error) {
            return fail(`could not open a shell pane: ${message(error)}`, 'OPEN_FAILED');
        }
        if (!paneID) return fail('the host did not return the new pane', 'OPEN_FAILED');
    } else {
        const target = typeof args.target === 'string' ? panes.find(p => p.id === args.target) : null;
        if (!target) return fail(`no pane ${args.target}`, 'NO_PANE');
        if ((target.type ?? 'shell') !== 'shell') return fail(`pane ${target.id} is not a terminal`, 'NOT_SHELL');
        // Same set the view offers (runTargets): a pane in the source pane's workspace, never one elsewhere.
        if (!source || target.workspaceID !== source.workspaceID) return fail(`pane ${target.id} is not in the source pane's workspace`, 'NOT_TARGET');
        if (isAgent(target) && args.allowAgent !== true) return fail(`pane ${target.id} is running an agent; pick it explicitly to type into it`, 'AGENT_PANE');
        if (isAgent(target) && args.text.trim().includes('\n')) return fail('Claude runs one ! line at a time; run a multi-line command in a new shell pane', 'MULTI_LINE');
        paneID = target.id;
        if (isAgent(target)) text = asBang(args.text);
    }
    try {
        await api.terminal.send(paneID, text);
    } catch (error) {
        return fail(`send failed: ${message(error)}`, 'SEND_FAILED');
    }
    return { ok: true, paneID };
}

/** Put text on the macOS clipboard with pbcopy (the plugin API has no clipboard). Resolves true when it worked. */
export function pbcopy(text) {
    return new Promise(resolve => {
        let child;
        try { child = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] }); } catch { resolve(false); return; }
        child.on('error', () => resolve(false));
        child.on('close', code => resolve(code === 0));
        child.stdin.end(text);
    });
}
