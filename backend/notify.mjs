// Turns `daemon.notification` (fires only for unattended panes) into attention items.
// The notification body holds no command text, so the command is read by capturing the pane.
import { createHash } from 'node:crypto';
import { addItem } from './attention.mjs';
import { actionableWorker, actionableOrchestrator, otherSwarmPane, anyClaudePane, anyCodexPane, capturePane } from './store.mjs';

// CSI sequences and OSC sequences (terminated by BEL or ESC \\). An unterminated escape is left in, which makes the prompt non-approvable.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
// Only the exact frame characters (never a plain "|") at the line edges: one left frame char with one space of padding, one right.
const BOX_LEFT = /^\s*[│┃║] ?/u;
const BOX_RIGHT = /\s*[│┃║]\s*$/u;
// A box frame line: three or more dashes with optional corners, or a corner-to-corner line of any width (a narrow pane
// draws `╭─╮`, and parsePrompt canonicalises the frame to that).
const FRAME = /^(?:[╭┌┏╔╒]?[─━═]{3,}[╮┐┓╗╕]?|[╭┌┏╔╒][─━═]+[╮┐┓╗╕])$/u;
const PRINTABLE = /^[\x20-\x7e\t]*$/;
const QUESTION = /^(?:do you want to|would you like to|allow\b|do you trust)/i;
const OPTION_YES = /^[❯>›]?\s*1[.)]\s*yes\b/i;
const CURSOR_YES = /^[❯›]\s*1[.)]\s*yes\b/i;
const CURSOR = /^[❯>›]\s*\d+[.)]\s/;
// Exact Claude permission header strings only (no wildcards: a command line such as `echo run command` must never act as a header).
// A subagent's prompt adds " · from the <name> agent" to the header. While several agents wait at once, Claude
// right-aligns a queue counter ("1 of 3") on the header line; Enter still answers the one shown.
const HEADER = /^(?:bash command|edit file|create file|write file|read file|fetch|web fetch|tool use)(?: · from the [\w .-]{1,40} agent)?(?:\s{2,}\d{1,3} of \d{1,3})?$/i;
// The dashed rules newer Claude versions draw above and below the command.
const RULE = /^[╌╍┄┅┈┉]{3,}$/u;
/** A narrow pane wraps the description and the notes; these bound how many lines each may take. */
const MAX_DESC = 6;
const MAX_NOTES = 10;
const DECOR = /^[\s─━┌┐└┘├┤┬┴┼╭╮╯╰═╔╗╚╝-]*$/u;

const OPTION_LINE = /^[❯>›]?\s*\d+[.)]\s/;
/** A live prompt is the bottom UI: its question must sit within this many non-empty lines of the end of the capture. */
export const PROMPT_WINDOW = 12;
/** Rows read from a pane: a tall pane has empty rows under the prompt, and 40 rows cut its header off. */
export const PROMPT_CAPTURE_LINES = 200;
const HEADER_REACH = 60;
const RAW_CONTEXT = 12;

/** sha256 hex of text with each line's whitespace collapsed (so layout changes do not matter, content changes do). */
export function promptHash(text) {
    const normal = String(text ?? '').split('\n').map(l => l.replace(/\s+/g, ' ').trim()).join('\n').trim();
    return createHash('sha256').update(normal).digest('hex');
}

/**
 * Detect a Claude permission prompt (a select menu: question, then "1. Yes ...") in captured pane text.
 * Only a prompt whose question sits in the last PROMPT_WINDOW non-empty lines counts (a fake one printed
 * earlier in worker output is ignored). `command` is EVERY line between the header and the question.
 * `block` is the whole prompt (header through the last option), the text that promptHash covers.
 * @returns {{ command: string, question: string, block: string, approvable: boolean } | null} approvable is false when the shape is not recognised (command is then '') null when no prompt is showing
 */
export function parsePrompt(captureText) {
    if (typeof captureText !== 'string') return null;
    const lines = captureText.replace(ANSI, '').split('\n').map(line => line.replace(BOX_LEFT, '').replace(BOX_RIGHT, '').trim());
    const filled = [];
    lines.forEach((l, i) => { if (l) filled.push(i); });
    const windowStart = filled[Math.max(0, filled.length - PROMPT_WINDOW)] ?? 0;
    let q = -1;
    for (let i = lines.length - 1; i >= windowStart; i -= 1) {
        if (QUESTION.test(lines[i])) { q = i; break; }
    }
    if (q < 0) return null;
    const optionRows = lines.slice(q + 1, q + 8);
    if (!optionRows.some(l => OPTION_YES.test(l))) return null;
    let lastOption = q;
    optionRows.forEach((l, k) => { if (OPTION_LINE.test(l)) lastOption = q + 1 + k; });
    // Recognised shape (contiguous): HEADER, at most one blank/decor line, ONE run of command lines with no blank or
    // decor line inside it, at most one blank/decor line, then the question. Anything else (a gap, extra text, no
    // header within HEADER_REACH) is unrecognised: the raw block is still returned but approvable is false.
    const blank = l => !l || DECOR.test(l);
    // A narrow pane wraps the question ("Do you want to" / "proceed?"): one plain continuation line directly under it,
    // with the first option right after, is part of the question.
    const tail = lines[q + 1] ?? '';
    const wrapped = !!tail && !blank(tail) && !OPTION_LINE.test(tail) && OPTION_LINE.test(lines[q + 2] ?? '')
        && !HEADER.test(tail) && !RULE.test(tail) && !FRAME.test(tail);
    const question = wrapped ? `${lines[q]} ${tail}` : lines[q];
    // Use the TOPMOST header within reach, not the nearest: a second header-looking line inside a command then lands in the
    // command run (non-approvable) instead of hiding the lines above it.
    let headerAt = -1;
    for (let i = Math.max(0, q - HEADER_REACH); i < q; i += 1) if (HEADER.test(lines[i])) { headerAt = i; break; }
    // The header must have the box frame line directly above it (the hash covers the block from that frame).
    const frameAt = headerAt >= 1 && FRAME.test(lines[headerAt - 1]) ? headerAt - 1 : -1;
    let approvable = false;
    let commandLines = [];
    if (headerAt >= 0 && frameAt >= 0) {
        let i = headerAt + 1;
        if (i < q && blank(lines[i])) i += 1;
        const runStart = i;
        while (i < q && !blank(lines[i])) i += 1;
        const runEnd = i;
        if (i < q && blank(lines[i])) i += 1;
        // Try the ruled layout first: its lines also form one unbroken run, which the old shape would swallow whole.
        const v2 = ruledCommand(lines, headerAt, q, blank);
        if ((i === q && runEnd > runStart) || v2) {
            commandLines = v2 || lines.slice(runStart, runEnd);
            // A command line that itself looks like a header is an attempt to fake the prompt layout; plain printable ASCII only;
            // and the selection cursor must sit on "1. Yes" (Enter selects the highlighted option).
            const cursorRow = optionRows.find(l => CURSOR.test(l));
            approvable = !commandLines.some(l => HEADER.test(l) || FRAME.test(l) || RULE.test(l))
                && commandLines.every(l => PRINTABLE.test(l))
                && !!cursorRow && CURSOR_YES.test(cursorRow);
        }
    }
    let start;
    if (frameAt >= 0) start = frameAt;
    else if (headerAt >= 0) start = headerAt;
    else {
        // Unrecognised: show up to RAW_CONTEXT non-empty lines above the question.
        const above = [];
        for (let i = q - 1; i >= 0 && above.length < RAW_CONTEXT; i -= 1) if (!blank(lines[i])) above.push(i);
        start = above.length ? above[above.length - 1] : q;
    }
    // The frame line is kept (canonicalised so a terminal resize does not change the hash); other blank/decor lines are dropped.
    const block = lines.slice(start, lastOption + 1).map((l, k) => (start + k === frameAt ? '╭─╮' : l))
        .filter((l, k) => start + k === frameAt || !blank(l)).join('\n');
    return { command: approvable ? commandLines.join('\n') : '', question, block, approvable };
}

// Codex approvals and queued questions produce navigation cards, never automatic answers.
const CODEX_QUESTION = /^(?:Would you like to (?:run the following command|send input to (?:the existing )?terminal|grant these permissions|make the following edits)\?|Do you want to approve network access to .+\?|.+ needs your approval\.)$/i;
const CODEX_YES = /^[❯›>]?\s*1[.)]\s*Yes(?:,|\b)/i;
export function parseCodexPrompt(captureText) {
    if (typeof captureText !== 'string') return null;
    const lines = captureText.replace(ANSI, '').split('\n').map(line => line.trim());
    const filled = lines.map((line, index) => line ? index : -1).filter(index => index >= 0);
    const start = filled[Math.max(0, filled.length - 25)] ?? 0;
    for (let q = lines.length - 1; q >= start; q -= 1) {
        const queued = /^\?\s+([1-9]\d*)\s+questions?$/i.exec(lines[q]);
        if (queued && lines.slice(Math.max(start, q - 2), q).some(line => /^(?:[•·]\s+)?Queued follow-up inputs$/i.test(line))) {
            const hint = /^(\S.*?)\s+to answer$/.exec(lines[q + 1] ?? '');
            if (hint) {
                const shortcut = hint[1] === '⇧←' ? 'Shift+Left Arrow' : hint[1];
                return {
                    question: `${queued[1]} question${queued[1] === '1' ? '' : 's'} waiting; press ${shortcut} in Codex to answer`,
                    block: `Queued follow-up inputs\n${lines[q]}\n${lines[q + 1]}`,
                    command: '', approvable: false, inputQuestion: true
                };
            }
        }
        if (/^Trust this folder\?(?:\s|$)/i.test(lines[q])) {
            const trust = lines.findIndex((line, index) => index > q && index <= q + 12 && /^[❯›>]?\s*1[.)]\s*Trust and continue$/i.test(line));
            if (trust >= 0 && lines.slice(trust + 1, trust + 4).some(line => /^[❯›>]?\s*2[.)]\s*Quit$/i.test(line))) {
                return { question: 'Codex needs folder trust before this worker can start',
                    block: lines.slice(Math.max(start, q - 8), trust + 4).filter(Boolean).join('\n'),
                    command: '', approvable: false, folderTrust: true };
            }
        }
        if (!CODEX_QUESTION.test(lines[q])) continue;
        const optionAt = lines.findIndex((line, index) => index > q && index <= q + 20 && CODEX_YES.test(line));
        if (optionAt < 0) continue;
        const last = Math.min(lines.length - 1, optionAt + 4);
        return { question: lines[q], block: lines.slice(q, last + 1).filter(Boolean).join('\n'), command: '', approvable: false };
    }
    return null;
}

/**
 * The newer layout, contiguous: HEADER, up to MAX_DESC description lines (a narrow pane wraps the description), a
 * dashed RULE, ONE run of command lines, a RULE, up to MAX_NOTES note lines (e.g. "Permission rule Bash(mv *)
 * requires confirmation", wrapped in a narrow pane), at most one blank line, then the question. Returns the command
 * lines (exactly the lines between the two rules), or null when the shape does not match exactly.
 */
function ruledCommand(lines, headerAt, q, blank) {
    // Exactly two rules: a rule-looking line inside the command can never split it.
    if (lines.slice(headerAt + 1, q).filter(l => RULE.test(l)).length !== 2) return null;
    let i = headerAt + 1;
    let desc = 0;
    while (i < q && !blank(lines[i]) && !RULE.test(lines[i]) && desc < MAX_DESC) {
        if (HEADER.test(lines[i]) || FRAME.test(lines[i]) || QUESTION.test(lines[i]) || OPTION_LINE.test(lines[i])) return null;
        desc += 1; i += 1;
    }
    if (!RULE.test(lines[i] ?? '')) return null;
    const runStart = ++i;
    while (i < q && !blank(lines[i]) && !RULE.test(lines[i])) i += 1;
    if (i === runStart || !RULE.test(lines[i] ?? '')) return null;
    const command = lines.slice(runStart, i);
    i += 1;
    let notes = 0;
    while (i < q && !blank(lines[i]) && notes < MAX_NOTES) {
        const l = lines[i];
        if (HEADER.test(l) || FRAME.test(l) || RULE.test(l) || QUESTION.test(l) || OPTION_LINE.test(l)) return null;
        notes += 1; i += 1;
    }
    if (i < q && blank(lines[i])) i += 1;
    return i === q ? command : null;
}

const labelFor =(store, paneID) => store.manifestWorkers.find(w => w.paneID === paneID)?.label
    ?? (store.orchestrator?.paneID === paneID ? store.orchestrator.label : null) ?? store.panes.get(paneID)?.label ?? paneID;

/**
 * Handle a `daemon.notification` event for a swarm pane (worker or orchestrator). A pane of another live swarm
 * (otherSwarmPane) can raise a Request only. Others are ignored. `screen` is a capture the caller already took (the
 * prompt scan), so the pane is not captured twice.
 * @returns {Promise<{ ok: true, ignored?: string, item?: object }>}
 */
export async function onNotification(api, store, att, event, { screen } = {}) {
    const n = event?.data ?? event ?? {};
    const paneID = n.paneID;
    if (typeof paneID !== 'string') return { ok: true, ignored: 'no-pane' };
    const codex = anyCodexPane(store, paneID) || store.manifestWorkers.some(w => w.paneID === paneID && w.agent === 'codex')
        || (n.kind === 'agent-notification' && n.title === 'Codex')
        || (typeof screen === 'string' && !!parseCodexPrompt(screen));
    const inSwarm = !!actionableWorker(store, paneID) || actionableOrchestrator(store, paneID);
    // Another live swarm's pane: only its permission Requests are global; errors stay with the followed swarm.
    const other = inSwarm ? null : otherSwarmPane(store, paneID);
    // Any other Claude pane, while auto-approve is on: Requests only, like another swarm's pane.
    const claude = !inSwarm && !other && anyClaudePane(store, paneID);
    if (!inSwarm && !other && !claude && !codex) return { ok: true, ignored: 'not-swarm' };
    const label = other ? other.label : labelFor(store, paneID);
    const isError = typeof n.kind === 'string' && n.kind.includes('error');
    if ((other || claude) && isError) return { ok: true, ignored: 'other-swarm-error' };
    if (isError) {
        store.errored.add(paneID);
        const { item } = await addItem(att, { type: 'Error', paneID, text: `${label}: ${n.body || n.title || 'agent reported an error'}` });
        return { ok: true, item };
    }
    if (codex) {
        let screenText = screen;
        if (typeof screenText !== 'string') {
            try { screenText = await capturePane(api, paneID, PROMPT_CAPTURE_LINES); }
            catch { screenText = ''; }
        }
        const prompt = parseCodexPrompt(screenText);
        const block = prompt?.block ?? 'Codex approval requested';
        const { item } = await addItem(att, {
            type: 'Request', paneID, agent: 'codex', promptHash: promptHash(block), promptBlock: prompt?.block,
            approvable: false, text: prompt?.inputQuestion || prompt?.folderTrust
                ? `${label}: ${prompt.question}`
                : `${label} needs approval in Codex; open its pane to respond`,
            ...(other ? { swarmName: other.swarm.name, swarmWorkspaceID: other.swarm.workspaceID } : {})
        });
        return { ok: true, item };
    }
    let text = screen;
    try {
        if (typeof text !== 'string') text = await capturePane(api, paneID, PROMPT_CAPTURE_LINES);
    } catch {
        return { ok: true, ignored: 'capture-failed' };
    }
    const prompt = parsePrompt(text);
    if (!prompt) return { ok: true, ignored: 'no-prompt' };
    const { item } = await addItem(att, {
        type: 'Request', paneID, command: prompt.command, promptHash: promptHash(prompt.block),
        promptBlock: prompt.block, approvable: prompt.approvable,
        text: `${label} is asking: ${prompt.question}`,
        ...(other ? { swarmName: other.swarm.name, swarmWorkspaceID: other.swarm.workspaceID } : {})
    });
    return { ok: true, item };
}
