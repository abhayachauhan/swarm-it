import { capturePane } from './store.mjs';
import { sendText } from './actions.mjs';
import { PROMPT_CAPTURE_LINES } from './notify.mjs';

/** The current Codex composer, excluding its footer; null when a menu or another screen is showing. */
export function codexInput(text) {
    const lines = String(text ?? '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').split('\n').filter(line => line.trim());
    const at = lines.findLastIndex(line => /^\s*›(?:\s|$)/.test(line));
    if (at < 0 || lines.length - at > 4) return null;
    const footer = /^(?:(?:[^\w]*for agents\s*·\s*)?\? for shortcuts.*|\d+% context left.*|[\w.-]+(?:\s+(?:minimal|low|medium|high|xhigh|default))?\s+·\s+[~/].*|⚠\s*\d+ warnings?\b.*)$/i;
    if (!lines.slice(at + 1).every(line => footer.test(line.trim()))) return null;
    const input = lines[at].replace(/^\s*›\s?/, '').trim();
    return input === 'Ask Codex to do anything' ? '' : input;
}

export const codexInputEmpty = text => codexInput(text) === '';

/** Read the exact session from this TUI; shared-daemon hooks may name an older pane or conversation. */
export async function readCodexSession(api, paneID, screen, { sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), pollMs = 250 } = {}) {
    const status = await sendText(api, paneID, '/status');
    if (!status.ok) return status;
    for (let waited = 0; waited < 2000; waited += pollMs) {
        await sleep(pollMs);
        let current;
        try { current = await capturePane(api, paneID, PROMPT_CAPTURE_LINES); } catch { continue; }
        if (current === screen || !codexInputEmpty(current)) continue;
        const matches = [...current.matchAll(/^\s*(?:[│┃║]\s*)?Session:\s*([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\b/gmi)];
        const session = matches.at(-1)?.[1];
        if (session) return { ok: true, session };
    }
    return { ok: false, error: 'Codex did not report its session ID through /status; it was left open', code: 'NO_SESSION' };
}
