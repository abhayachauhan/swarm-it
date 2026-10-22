// User actions. Nothing here merges, pushes or deletes a worktree. The only pane it closes is a manifest worker, in closeWorker.
// Every pane is addressed by pane id (labels do not resolve across workspaces).
import { handleItem } from './attention.mjs';
import { parsePrompt, promptHash, PROMPT_CAPTURE_LINES } from './notify.mjs';
import { isSafeLabel } from './manifest.mjs';
import { persist, deriveState, actionableWorker, actionableOrchestrator, otherSwarmPane, anyClaudePane, resultContext, readResultText, capturePane, rememberSession, SESSION_ID, textHash } from './store.mjs';
import { checkResultPath } from './safepath.mjs';
import { execFile } from 'node:child_process';

const fail = (error, code) => ({ ok: false, error, ...(code ? { code } : {}) });
const worker = (store, paneID) => actionableWorker(store, paneID);
const message = error => String(error?.message ?? error);

export const MAX_TEXT = 4000;
// Text policy for anything typed into a terminal (terminal.send appends Enter): 1..4000 chars, newline allowed only
// BETWEEN lines (not trailing), and no other control character (no ESC, CR, NUL, backspace, tab, DEL, C1).
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;
export function textProblem(text) {
    if (text.length > MAX_TEXT) return `text is longer than ${MAX_TEXT} characters`;
    if (CONTROL.test(text)) return 'text contains a control character';
    if (text.endsWith('\n')) return 'text must not end with a newline';
    return null;
}

export async function sendText(api, paneID, text) {
    if (typeof paneID !== 'string' || !paneID || typeof text !== 'string' || !text) return fail('paneID and text are required', 'BAD_ARGS');
    const problem = textProblem(text);
    if (problem) return fail(problem, 'BAD_TEXT');
    try {
        await api.terminal.send(paneID, text);
        return { ok: true, paneID };
    } catch (error) {
        return fail(`send failed: ${message(error)}`, 'SEND_FAILED');
    }
}

export async function sendToOrchestrator(api, store, text) {
    if (!store.orchestrator) return fail('no orchestrator is known', 'NO_ORCHESTRATOR');
    return sendText(api, store.orchestrator.paneID, text);
}

/** zsh single-quoted word: nothing inside is expanded; a quote is closed, escaped and reopened. */
export const shellQuote = text => `'${String(text).replace(/'/g, `'\\''`)}'`;

/**
 * Is Claude still alive in the pane by Kelpi's account? A live session id, or a running / waiting status. These go
 * stale when Claude dies without its SessionEnd hook, so this alone never decides that text may be typed.
 * Read fresh from panes.list; the last state change if that fails.
 */
async function kelpiSaysAlive(api, store, paneID) {
    let pane = null;
    try {
        pane = (await api.panes.list()).find(p => p?.id === paneID) ?? null;
        if (pane) rememberSession(store, paneID, pane.agentSessionID);
    } catch { /* fall back to the last state change */ }
    pane ??= store.panes.get(paneID);
    return !!pane?.agentSessionID || pane?.status === 'running' || pane?.status === 'waitingForInput';
}

const RULE = /^\s*[─━]{20,}\s*$/;
const INPUT = /^\s*❯(?:\s|$)/;
const MENU_OPTION = /^\s*❯\s*\d+[.)]\s/;
/**
 * Does the capture end in Claude Code's own input box: a full-width rule, the `❯` prompt (a permission menu's
 * `❯ 1. Yes` does not count), a closing rule, and at most a few status lines below it? A shell prompt never has the
 * rules around it, so a pane back at zsh does not pass, whatever its prompt character.
 */
export function showsClaudeInput(text) {
    const lines = String(text ?? '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').split('\n').filter(line => line.trim());
    for (let i = lines.length - 1; i > 0; i -= 1) {
        if (!INPUT.test(lines[i]) || MENU_OPTION.test(lines[i]) || !RULE.test(lines[i - 1])) continue;
        const close = lines.findIndex((line, k) => k > i && RULE.test(line));
        return close > i && lines.length - 1 - close <= 4;
    }
    return false;
}

/**
 * Send text to a manifest worker. Any other pane is refused with NOT_WORKER. A worker whose result file exists has
 * finished: Claude is started again in that pane on the worker's own conversation (`--resume <id>`, never
 * `--continue`: workers share a directory), whatever Kelpi reports about the pane. With no known session id it refuses
 * (NO_SESSION) and types nothing. Otherwise the text is typed only when a fresh capture shows Claude's own input box;
 * a pane Kelpi says Claude has left, of a worker that finished in error, is restarted the same way; anything else is
 * refused (NOT_AT_CLAUDE), so user text is never typed into a shell.
 */
export async function sendToWorker(api, store, paneID, text) {
    if (typeof paneID !== 'string' || !paneID) return fail('paneID is required', 'BAD_ARGS');
    const w = worker(store, paneID);
    if (!w) return fail(`pane ${paneID} is not a worker in the manifest`, 'NOT_WORKER');
    if (typeof text !== 'string' || !text) return fail('paneID and text are required', 'BAD_ARGS');
    const problem = textProblem(text);
    if (problem) return fail(problem, 'BAD_TEXT');
    if (w.agent === 'codex') {
        const session = store.sessions.get(paneID);
        if (!session || !SESSION_ID.test(session)) return fail('this Codex worker has no known conversation', 'NO_SESSION');
        const ask = `${text.trim().replace(/[.\s]+$/, '')}.${w.resultPath ? ` Write the updated result to ${w.resultPath}.` : ''} Reply done.`;
        const queued = await new Promise(resolve => execFile('codex', ['queue', '--thread', session, '--message', ask],
            { timeout: 5000 }, (error) => resolve(error)));
        if (queued) return fail(`Codex follow-up could not be queued: ${message(queued)}`, 'QUEUE_FAILED');
        let baseline = '';
        if (w.resultPath) {
            const checked = await checkResultPath(w, store.settings, undefined, resultContext(store, paneID));
            const read = checked.ok ? await readResultText(store, checked.path) : null;
            if (read?.ok) baseline = textHash(read.text);
        }
        store.restarts.set(paneID, baseline);
        store.resultExists.set(paneID, false);
        store.errored.delete(paneID);
        store.accepted.delete(paneID);
        await persist(store);
        return { ok: true, paneID, restarted: true };
    }
    const alive = await kelpiSaysAlive(api, store, paneID);
    let screen = null;
    try { screen = await capturePane(api, paneID, PROMPT_CAPTURE_LINES); } catch { /* treated as unknown */ }
    // The restart line ends in Enter: never let it land on an open permission menu, where Enter means Yes.
    if (screen === null || parsePrompt(screen)) return fail('the worker pane shows a permission prompt or cannot be read; nothing was typed. Answer it in the pane', 'PROMPT_OPEN');
    if (store.resultExists.get(paneID) !== true) {
        if (showsClaudeInput(screen)) return sendText(api, paneID, text);
        const ended = !alive && (store.sessions.has(paneID) || ['done', 'error'].includes(deriveState(store, w)));
        if (!ended) return fail('the worker pane does not show Claude\'s input box; nothing was typed. Answer it in the pane', 'NOT_AT_CLAUDE');
    }
    const session = store.sessions.get(paneID);
    if (!session || !SESSION_ID.test(session)) return fail('this worker has finished and its conversation cannot be found', 'NO_SESSION');
    const ask = `${text.trim().replace(/[.\s]+$/, '')}.${w.resultPath ? ` Write the updated result to ${w.resultPath}.` : ''} Reply done.`;
    const line = `claude -p --resume ${session} --permission-mode auto ${shellQuote(ask)}`;
    // The old result must change before the worker reads as done again.
    let baseline = '';
    if (w.resultPath) {
        const checked = await checkResultPath(w, store.settings, undefined, resultContext(store, paneID));
        const read = checked.ok ? await readResultText(store, checked.path) : null;
        if (read?.ok) baseline = textHash(read.text);
    }
    const sent = await sendText(api, paneID, line);
    if (!sent.ok) return sent;
    store.restarts.set(paneID, baseline);
    store.restartRan.delete(paneID);
    store.resultExists.set(paneID, false);
    store.errored.delete(paneID);
    store.accepted.delete(paneID);
    await persist(store);
    return { ok: true, paneID, restarted: true };
}

/**
 * Open the worker's own manifest resultPath. The caller cannot supply a path.
 *
 * Finding (read-only look at ~/repos/kelpi, docs/csv-pane.md and docs/socket-handlers.md 8.1): the plugin SDK's
 * `api.files.open(path)` sends the ordinary wire `open` command. The daemon opens a pane inside Kelpi: a csv pane for
 * .csv/.tsv, a markdown pane for any other extension. It never hands the file to the OS default handler (no
 * shell.openPath / `open`). That is why we also restrict the extension: a markdown pane renders a .json or .log as
 * text, whereas it would be wrong to rely on the viewer to refuse anything. The path is validated first (extension
 * allowlist, symlinks resolved, contained in the worker's worktree or the workspace root), then the file is opened here
 * with O_NOFOLLOW and inspected (regular file, one link, size cap, still the same file) immediately before the RESOLVED
 * path is handed to the host. The host opens the path by name, so a swap between that inspection and the host's own
 * open cannot be excluded from here; the window is the length of one call, not a stale policy decision.
 */
export async function openResult(api, store, paneID) {
    if (typeof paneID !== 'string' || !paneID) return fail('paneID is required', 'BAD_ARGS');
    const w = worker(store, paneID);
    if (!w) return fail(`pane ${paneID} is not a worker in the manifest`, 'NOT_WORKER');
    if (!w.resultPath) return fail('worker has no result path', 'NO_RESULT');
    const checked = await checkResultPath(w, store.settings, undefined, resultContext(store, paneID));
    if (!checked.ok) return checked;
    const inspected = await readResultText(store, checked.path);
    if (!inspected.ok) return fail(inspected.error, inspected.code);
    try {
        await api.files.open(checked.path);
    } catch (error) {
        return fail(`cannot open ${w.resultPath}: ${message(error)}`, 'OPEN_FAILED');
    }
    return { ok: true, path: checked.path };
}

export async function captureWorker(api, store, paneID, lines = 60) {
    if (typeof paneID !== 'string' || !paneID) return fail('paneID is required', 'BAD_ARGS');
    if (!worker(store, paneID)) return fail(`pane ${paneID} is not a worker in the manifest`, 'NOT_WORKER');
    const count = Number.isFinite(lines) && lines > 0 ? Math.min(Math.floor(lines), 2000) : 60;
    try {
        return { ok: true, text: await capturePane(api, paneID, count) };
    } catch (error) {
        return fail(`capture failed: ${message(error)}`, 'CAPTURE_FAILED');
    }
}

function sectionOf(text, name) {
    const lines = text.split('\n');
    const start = new RegExp(`^\\s{0,3}(?:#{1,6}\\s*${name}\\b.*|\\*\\*${name}\\*\\*\\s*[:\\-]?\\s*)$`, 'i');
    const anyHeading = /^\s{0,3}(?:#{1,6}\s+\S.*|\*\*[^*]+\*\*\s*[:\-]?\s*)$/;
    const from = lines.findIndex(line => start.test(line));
    if (from < 0) return '';
    const body = [];
    for (const line of lines.slice(from + 1)) {
        if (anyHeading.test(line)) break;
        body.push(line);
    }
    return body.join('\n').trim();
}

export async function readResult(api, store, paneID) {
    const w = worker(store, paneID);
    if (!w) return fail(`pane ${paneID} is not a worker in the manifest`, 'NOT_WORKER');
    if (!w.resultPath) return fail('worker has no result path', 'NO_RESULT');
    const checked = await checkResultPath(w, store.settings, undefined, resultContext(store, paneID));
    if (!checked.ok) return checked;
    // One open handle: O_NOFOLLOW, regular file, one link, size cap, and the bytes are read from that same handle.
    const read = await readResultText(store, checked.path);
    if (!read.ok) return fail(read.code === 'NO_RESULT' ? `cannot read ${w.resultPath}: ${read.error}` : read.error, read.code === 'TIMEOUT' ? 'NO_RESULT' : read.code);
    const text = read.text;
    return { ok: true, path: checked.path, text, summary: { goal: sectionOf(text, 'goal'), done: sectionOf(text, 'done'), next: sectionOf(text, 'next') } };
}

/**
 * Approve is bound to what the user reviewed: the LIVE prompt's command AND
 * hash of its whole block must equal both the stored item and the hash the view sent. Deny only needs a prompt present.
 */
async function answerRequest(api, store, itemID, key, sentHash) {
    const strict = key === 'enter';
    if (strict && (typeof sentHash !== 'string' || !sentHash)) return fail('promptHash is required to approve', 'BAD_ARGS');
    const item = store.attention.find(i => i.id === itemID);
    if (!item) return fail(`no attention item ${itemID}`, 'NOT_FOUND');
    if (item.type !== 'Request') return fail('only a Request can be approved or denied', 'NOT_REQUEST');
    if (item.handledAt) return fail('item already handled', 'HANDLED');
    if (store.panes.get(item.paneID)?.agent === 'codex' || worker(store, item.paneID)?.agent === 'codex') return fail('answer Codex approval requests in its pane', 'UNSUPPORTED_AGENT');
    if (item.approvable === false) return fail('this prompt is not in a recognised shape; answer it in the pane', 'NOT_APPROVABLE');
    // The followed swarm's worker or orchestrator, a pane of another live, correctly owned swarm (otherSwarmPane), or
    // any Claude pane while auto-approve is on (anyClaudePane).
    if (!worker(store, item.paneID) && !actionableOrchestrator(store, item.paneID) && !otherSwarmPane(store, item.paneID) && !anyClaudePane(store, item.paneID)) return fail(`pane ${item.paneID} is not an actionable swarm pane`, 'NOT_WORKER');
    // Kelpi often leaves a prompting pane at "running", so any live state passes. An idle pane with no session is a shell:
    // a prompt left on its screen (Claude killed mid-prompt, or printed text) must never get an Enter typed into it.
    const live = store.panes.get(item.paneID);
    if (!live?.agentSessionID && live?.status !== 'running' && live?.status !== 'waitingForInput') return fail('Claude is no longer running in that pane', 'STALE');
    // Capture and verify the LIVE prompt; done twice, the second time immediately before the key goes out, so a prompt swapped
    // while the first check was awaiting cannot receive the keypress.
    const verifyLive = async () => {
        let text;
        try {
            text = await capturePane(api, item.paneID, PROMPT_CAPTURE_LINES);
        } catch (error) {
            return fail(`cannot check the pane: ${message(error)}`, 'STALE');
        }
        const live = parsePrompt(text);
        if (!live) return fail('the pane no longer shows a permission prompt', 'STALE');
        if (live.approvable === false) return fail('this prompt is not in a recognised shape; answer it in the pane', 'NOT_APPROVABLE');
        if (strict) {
            const liveHash = promptHash(live.block);
            if (!item.promptHash || !item.command || live.command !== item.command || liveHash !== item.promptHash || liveHash !== sentHash) {
                return fail('the permission prompt changed since it was displayed; review it again', 'STALE');
            }
        }
        return null;
    };
    const first = await verifyLive();
    if (first) return first;
    const second = await verifyLive();
    if (second) return second;
    try {
        await api.terminal.sendKey(item.paneID, key);
    } catch (error) {
        return fail(`send key failed: ${message(error)}`, 'SEND_FAILED');
    }
    await handleItem(store.att, itemID);
    return { ok: true, itemID };
}

/** Enter selects "Yes" in Claude's permission menu. */
export const approve = (api, store, itemID, sentHash) => answerRequest(api, store, itemID, 'enter', sentHash);
/** Escape declines. */
export const deny = (api, store, itemID) => answerRequest(api, store, itemID, 'escape');

/**
 * Mark a finished worker reviewed and tell the orchestrator. Calls no destructive API:
 * only terminal.send to the orchestrator and storage writes.
 */
export async function accept(api, store, paneID) {
    const w = worker(store, paneID);
    if (!w) return fail(`pane ${paneID} is not a worker in the manifest`, 'NOT_WORKER');
    const state = deriveState(store, w);
    if (state !== 'done' && state !== 'error') return fail(`worker is ${state}, not finished`, 'NOT_FINISHED');
    if (!isSafeLabel(w.label)) return fail('worker label has characters that are not allowed; not messaging the orchestrator', 'BAD_LABEL');
    store.accepted.add(paneID);
    for (const item of store.attention) {
        if (item.paneID === paneID && item.type === 'Complete' && !item.handledAt) await handleItem(store.att, item.id);
    }
    await persist(store);
    const sent = await sendToOrchestrator(api, store,
        `Reviewed and accepted worker "${w.label}" (pane ${paneID}). Nothing was merged, pushed or closed.`);
    return { ok: true, paneID, notified: sent.ok };
}

/** A failure when the worker's worktree is dirty (DIRTY) or its git status is unknown (UNKNOWN_GIT); null when clean or there is none. */
export async function worktreeProblem(api, w) {
    if (!w.worktreePath) return null;
    let status;
    try {
        status = await api.services.call('kelpi.git', 1, 'getStatus', { repoPath: w.worktreePath });
    } catch (error) {
        return fail(`git status for ${w.worktreePath} is unknown (${message(error)}); not archiving`, 'UNKNOWN_GIT');
    }
    if (status?.kind === 'dirty') {
        return fail(`worktree ${w.worktreePath} has uncommitted changes (${status.changedFiles ?? '?'} files); not archiving`, 'DIRTY');
    }
    if (status?.kind !== 'clean') return fail(`git status for ${w.worktreePath} is unknown; not archiving`, 'UNKNOWN_GIT');
    return null;
}

/**
 * Hide a worker from the rail. Refuses when its worktree is dirty (DIRTY) or its git status is unknown (UNKNOWN_GIT).
 * Never deletes the worktree and never closes the pane (contracts/commands.md).
 */
export async function archive(api, store, paneID) {
    const w = worker(store, paneID);
    if (!w) return fail(`pane ${paneID} is not a worker in the manifest`, 'NOT_WORKER');
    const problem = await worktreeProblem(api, w);
    if (problem) return problem;
    store.archived.add(paneID);
    for (const item of store.attention) {
        if (item.paneID === paneID && !item.handledAt) await handleItem(store.att, item.id);
    }
    await persist(store);
    return { ok: true, paneID };
}

/**
 * Stop a manifest worker: archive it (same dirty-worktree refusal), then close its pane, which ends the shell and the
 * agent in it. Only a manifest worker passes the gate; the orchestrator and every other pane are refused. Nothing is
 * deleted on disk and no worktree is touched.
 */
export async function closeWorker(api, store, paneID) {
    const w = worker(store, paneID);
    if (!w) return fail(`pane ${paneID} is not a worker in the manifest`, 'NOT_WORKER');
    const wasArchived = store.archived.has(paneID);
    const archived = await archive(api, store, paneID);
    if (!archived.ok) return archived;
    try {
        await api.panes.close(paneID);
    } catch (error) {
        if (!wasArchived) store.archived.delete(paneID);
        await persist(store);
        return fail(`close failed: ${message(error)}`, 'CLOSE_FAILED');
    }
    return { ok: true, paneID };
}

/**
 * Remove a worker whose pane is already closed from the rail. Nothing runs any more, so there is no git check and no
 * pane to close: it is marked archived (persisted) and its open cards are settled. The manifest file is never edited.
 * A worker whose pane is still open is refused (PANE_OPEN): stop it first.
 */
export async function dismissWorker(api, store, paneID) {
    if (typeof paneID !== 'string' || !paneID) return fail('paneID is required', 'BAD_ARGS');
    // actionableWorker needs a live pane; a dismiss is exactly for a worker without one, so gate on the manifest list.
    const w = store.manifestWorkers.find(x => x.paneID === paneID);
    if (!w) return fail(`pane ${paneID} is not a worker in the manifest`, 'NOT_WORKER');
    if (store.panes.has(paneID)) return fail('the worker pane is still open; stop it instead', 'PANE_OPEN');
    store.archived.add(paneID);
    for (const item of store.attention) {
        if (item.paneID === paneID && !item.handledAt) await handleItem(store.att, item.id);
    }
    await persist(store);
    return { ok: true, paneID };
}

/**
 * Clear every finished worker of the followed swarm off the rail in one go: done or error workers have their pane
 * closed (closeWorker, same dirty-worktree refusal), closed panes are dismissed. Running and waiting workers are never
 * touched. A worker that refuses is kept and named in the error (PARTIAL); the rest are still cleared.
 */
export async function clearDone(api, store) {
    const cleared = [];
    const kept = [];
    for (const w of [...store.manifestWorkers]) {
        if (store.archived.has(w.paneID)) continue;
        const state = deriveState(store, w);
        if (state !== 'done' && state !== 'error') continue;
        const result = store.panes.has(w.paneID) ? await closeWorker(api, store, w.paneID) : await dismissWorker(api, store, w.paneID);
        if (result.ok) cleared.push(w.paneID);
        else kept.push({ paneID: w.paneID, label: w.label, code: result.code, error: result.error });
    }
    if (!kept.length) return { ok: true, cleared, kept };
    const names = kept.map(k => `${k.label || k.paneID} (${k.error})`).join('; ');
    return { ...fail(`cleared ${cleared.length}, kept ${kept.length}: ${names}`, 'PARTIAL'), cleared, kept };
}

/** Settle the open Complete cards of a worker once the user opened its result (thread view, Open, read). Returns true when one was. */
export async function settleComplete(store, paneID) {
    let settled = false;
    for (const item of store.attention) {
        if (item.paneID === paneID && item.type === 'Complete' && !item.handledAt) { await handleItem(store.att, item.id); settled = true; }
    }
    return settled;
}

/** Manual orchestrator pin. The manifest and the label still take precedence when present. */
export async function pinOrchestrator(api, store, paneID) {
    if (typeof paneID !== 'string' || !store.panes.has(paneID)) return fail(`unknown pane ${paneID}`, 'NO_PANE');
    if (store.manifestWorkers.some(w => w.paneID === paneID)) return fail('a manifest worker cannot be the orchestrator', 'IS_WORKER');
    store.pinnedOrchestratorPaneID = paneID;
    await persist(store);
    return { ok: true };
}
