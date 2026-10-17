// Restart Claude in a pane on the same conversation: quit it with /exit, wait for the shell, type `claude --resume <id>`.
// The id is the live one Kelpi reports, else the plugin's own copy (store.sessions), which outlives Claude exiting.
import { parsePrompt, PROMPT_CAPTURE_LINES } from './notify.mjs';
import { capturePane, rememberSession, SESSION_ID } from './store.mjs';
import { sendText, showsClaudeInput, textProblem } from './actions.mjs';

const fail = (error, code) => ({ ok: false, error, ...(code ? { code } : {}) });
const message = error => String(error?.message ?? error);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** How long to wait for Claude to exit after /exit, and how often to look. */
export const EXIT_TIMEOUT_MS = Number(process.env.SWARM_RESTART_EXIT_TIMEOUT_MS) || 15000;
export const EXIT_POLL_MS = 250;
/** Time for the shell to draw its prompt after Claude has gone. */
export const SHELL_SETTLE_MS = 500;
/** Time for typed text to show on screen before it is checked. */
export const TYPE_SETTLE_MS = 150;

const RULE = /^\s*[─━]{20,}\s*$/;
const BACKGROUND = /\bWaiting for \d+ background|\b\d+ background (?:agent|task)s? (?:running|still)/i;

/** Is Claude's input box empty? A `/exit` typed after a half-written prompt would send both as one message. */
export function claudeInputEmpty(text) {
    const lines = String(text ?? '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').split('\n').filter(line => line.trim());
    for (let i = lines.length - 1; i > 0; i -= 1) {
        const input = /^\s*❯(.*)$/.exec(lines[i]);
        if (!input || !RULE.test(lines[i - 1])) continue;
        // An empty box shows a dim hint, `Try "..."`, which reads as text once captured.
        return /^(?:Try ".*")?$/.test(input[1].trim()) && RULE.test(lines[i + 1] ?? '');
    }
    return false;
}

/**
 * Type the resume line without Enter, check what reached the shell, then press Enter. Kelpi types text as a bracketed
 * paste; a shell whose paste widget is broken (zsh after Homebrew removed its old functions folder) keeps the
 * paste end's `~`, so `claude --resume <id>~` would open Claude's session picker. A stray `~` is erased; anything
 * else that does not match is left unsent.
 */
export async function typeResumeLine(api, paneID, line, sleep = pause) {
    const problem = textProblem(line);
    if (problem) return fail(problem, 'BAD_TEXT');
    const typed = async () => {
        await sleep(TYPE_SETTLE_MS);
        try { return (await capturePane(api, paneID, 10)).split('\n').filter(l => l.trim()).at(-1) ?? ''; } catch { return ''; }
    };
    try {
        await api.terminal.send(paneID, line, { bare: true });
        let screen = await typed();
        if (screen.includes(`${line}~`)) {
            await api.terminal.sendKey(paneID, 'backspace');
            screen = await typed();
            if (screen.includes(`${line}~`)) return fail('the shell kept a stray ~ after the resume line; nothing was run', 'TYPED_WRONG');
        }
        if (!screen.includes(line)) return fail('the resume line did not reach the shell as typed; nothing was run', 'TYPED_WRONG');
        await api.terminal.sendKey(paneID, 'enter');
        return { ok: true, paneID };
    } catch (error) {
        return fail(`send failed: ${message(error)}`, 'SEND_FAILED');
    }
}

async function freshPane(api, paneID) {
    try { return (await api.panes.list()).find(p => p?.id === paneID) ?? null; } catch { return null; }
}

/**
 * Restart Claude in `paneID`. Returns `{ result, finished }`: `result` once /exit is typed (or at once when Claude has
 * already exited), `finished` when the resume line is typed or the wait gives up. Refused, with nothing typed, when
 * the pane is not a terminal, has no known session, shows a permission prompt, is mid-reply, has background agents,
 * or has text in Claude's input box.
 */
export async function restartClaude(api, store, paneID, deps = {}) {
    const sleep = deps.sleep ?? pause;
    const timeoutMs = deps.timeoutMs ?? EXIT_TIMEOUT_MS;
    const done = result => ({ result, finished: Promise.resolve(result) });
    if (typeof paneID !== 'string' || !paneID) return done(fail('paneID is required', 'BAD_ARGS'));
    const pane = await freshPane(api, paneID);
    if (!pane) return done(fail(`no pane ${paneID}`, 'NO_PANE'));
    if ((pane.type ?? 'shell') !== 'shell') return done(fail(`pane ${paneID} is not a terminal`, 'NOT_SHELL'));
    rememberSession(store, paneID, pane.agentSessionID);
    const session = pane.agentSessionID ?? store.sessions.get(paneID);
    if (typeof session !== 'string' || !SESSION_ID.test(session)) return done(fail('no Claude session is known for this pane', 'NO_SESSION'));
    const resumeLine = `claude --resume ${session}`;

    let screen;
    try { screen = await capturePane(api, paneID, PROMPT_CAPTURE_LINES); } catch (error) { return done(fail(`capture failed: ${message(error)}`, 'CAPTURE_FAILED')); }
    if (parsePrompt(screen)) return done(fail('Claude is showing a permission prompt; answer it first', 'PROMPT_OPEN'));

    const atClaude = showsClaudeInput(screen);
    if (!atClaude) {
        // Claude has already exited: the pane is back at its shell.
        if (pane.agentSessionID || pane.status === 'running') return done(fail('Claude is busy in this pane; wait for it to finish', 'BUSY'));
        const sent = await typeResumeLine(api, paneID, resumeLine, sleep);
        return done(sent.ok ? { ok: true, paneID, session, resumed: true } : sent);
    }
    if (pane.status === 'running') return done(fail('Claude is mid-reply; wait for it to finish', 'BUSY'));
    if (BACKGROUND.test(screen.split('\n').slice(-20).join('\n'))) return done(fail('Claude has background agents running; quitting would stop them', 'BACKGROUND'));
    if (!claudeInputEmpty(screen)) return done(fail('Claude\'s input box has text in it; clear it first', 'INPUT_NOT_EMPTY'));

    const quit = await sendText(api, paneID, '/exit');
    if (!quit.ok) return done(quit);

    const finished = (async () => {
        for (let waited = 0; waited < timeoutMs; waited += EXIT_POLL_MS) {
            await sleep(EXIT_POLL_MS);
            const now = await freshPane(api, paneID);
            if (!now) return fail('the pane closed', 'NO_PANE');
            let text = null;
            try { text = await capturePane(api, paneID, 40); } catch { continue; }
            // Gone once its input box is and either Kelpi cleared the session or Claude printed its goodbye line.
            if (showsClaudeInput(text) || (now.agentSessionID && !/Resume this session with/.test(text))) continue;
            await sleep(SHELL_SETTLE_MS);
            const sent = await typeResumeLine(api, paneID, resumeLine, sleep);
            return sent.ok ? { ok: true, paneID, session, resumed: true } : sent;
        }
        return fail(`Claude did not exit within ${Math.round(timeoutMs / 1000)}s; nothing more was typed`, 'EXIT_TIMEOUT');
    })();
    return { result: { ok: true, paneID, session, restarting: true }, finished };
}
