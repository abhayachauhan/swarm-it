import { capturePane } from './store.mjs';
import { codexInput, codexInputEmpty, readCodexSession } from './codex-session.mjs';
import { PROMPT_CAPTURE_LINES, parseCodexPrompt } from './notify.mjs';

/** Prefer session IDs. A unique matching title and Codex footer can locate an unlinked live pane. */
export async function locateCodexPane(api, store, threadID, name, options = {}) {
    if (typeof threadID !== 'string' || !threadID) return { ok: false, error: 'Codex session is required', code: 'BAD_SESSION' };
    const panes = (await api.panes.list()).filter(p => (p.type ?? 'shell') === 'shell');
    const known = panes.find(p => p.agentSessionID === threadID || store.sessions?.get(p.id) === threadID);
    if (known) return { ok: true, paneID: known.id };
    // Duplicate names require /status to disambiguate; never select a workspace by directory.
    const candidates = name ? panes.filter(p => p.title?.includes(name)) : panes;
    const screens = [];
    for (const pane of candidates.slice(0, 6)) {
        try { screens.push({ pane, screen: await capturePane(api, pane.id, PROMPT_CAPTURE_LINES) }); } catch { /* unavailable pane */ }
    }
    const named = name ? screens.filter(({ screen }) => codexInput(screen) !== null
        && screen.split('\n').filter(l => l.trim()).slice(-4).some(l => l.includes(name))) : [];
    if (named.length === 1) return { ok: true, paneID: named[0].pane.id };
    for (const { pane, screen } of screens) {
        if (!codexInputEmpty(screen) || parseCodexPrompt(screen)
            || /Working[^\n]*esc to interrupt/i.test(screen.split('\n').filter(l => l.trim()).slice(-10).join('\n'))) continue;
        const status = await readCodexSession(api, pane.id, screen, options);
        if (!status.ok) continue;
        store.sessions?.set(pane.id, status.session);
        if (status.session === threadID) return { ok: true, paneID: pane.id };
    }
    return { ok: false, error: 'No open pane could be verified for this Codex session. Leave its prompt empty and try again when Codex is idle.', code: 'NO_PANE' };
}
