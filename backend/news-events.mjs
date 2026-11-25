// Which plugin events become worker news, once each. Agent hook events cover every swarm, so on a host that has them
// they are the source of `turn-done` and `error`; an older host falls back to the Complete and Error cards of the
// followed swarm. `blocked` comes from Request cards and open question menus, `exited` from session end or pane close.
import { newsWorker, writeNews, lastNewsKind, resultNote } from './news.mjs';
import { exitReason, lastMessageLine } from './exits.mjs';

/** `/clear` ends one session and starts the next: an end counts only when no new start follows within this time. */
const EXIT_CONFIRM_MS = Number(process.env.SWARM_EXIT_CONFIRM_MS) || 1500;
/** Captures without the question menu before it counts as answered: one half-drawn screen must not report it twice. */
const MENU_GONE_SCANS = 2;

export function createWorkerNews(api, store, { serial }) {
    /** Cards added since the last flush. */
    const added = [];
    /** Pane id to the timer that confirms its session really ended. */
    const ending = new Map();
    /** Pane id to { question, misses } for the question menu already reported. */
    const questions = new Map();
    let disposed = false;
    const hasAgentEvents = typeof api.agents?.onEvent === 'function';

    const cancelExit = paneID => { clearTimeout(ending.get(paneID)); ending.delete(paneID); };

    async function exited(paneID, fallback) {
        const worker = newsWorker(store, paneID);
        if (!worker || await lastNewsKind(store, paneID) === 'exited') return;
        await writeNews(store, paneID, 'exited', await resultNote(store, worker) || fallback);
    }

    async function confirmExit(paneID, reason) {
        if (disposed || !ending.delete(paneID)) return;
        try {
            if ((await api.panes.list()).find(p => p?.id === paneID)?.agentSessionID) return;
        } catch { /* the session-end event is the evidence */ }
        await exited(paneID, reason);
    }

    async function flush() {
        for (const item of added.splice(0)) {
            const worker = newsWorker(store, item.paneID);
            if (!worker) continue;
            const text = item.text.replace(`${worker.label} is asking: `, '').replace(`${worker.label}: `, '');
            if (item.type === 'Request') {
                if (!item.handledAt) await writeNews(store, item.paneID, 'blocked', item.command || text);
            } else if (!hasAgentEvents && await lastNewsKind(store, item.paneID) !== 'exited') {
                if (item.type === 'Error') await writeNews(store, item.paneID, 'error', text);
                else await writeNews(store, item.paneID, 'turn-done', await resultNote(store, worker) || text);
            }
        }
    }

    return {
        /**
         * A card was added (attention.mjs). It is written in a later queued task, so whatever answers the card in the
         * task that raised it (auto-approve) has run first.
         */
        onItem(item) {
            if (added.push(item) === 1) serial(flush).catch(() => {});
        },

        async onAgentEvent(event) {
            const paneID = event?.paneID;
            const worker = newsWorker(store, paneID);
            if (!worker) return;
            switch (event.type) {
                case 'start':
                case 'session-start':
                    cancelExit(paneID);
                    questions.delete(paneID);
                    break;
                case 'stop': {
                    // Background tasks still running: the worker is not idle yet, and another stop follows.
                    if (event.backgroundTasks > 0) break;
                    const last = lastMessageLine(event.lastAssistantMessage);
                    await writeNews(store, paneID, 'turn-done', await resultNote(store, worker) || last || 'turn finished');
                    break;
                }
                case 'error':
                    await writeNews(store, paneID, 'error', lastMessageLine(event.message) || 'the agent reported an error');
                    break;
                case 'session-end': {
                    // A session still bound to the pane means a newer one has already replaced the ended one.
                    if (event.sessionID) break;
                    const reason = exitReason(store.agentErrors.get(paneID), store.agentLines.get(paneID), worker.agent === 'codex' ? 'Codex' : 'Claude');
                    cancelExit(paneID);
                    const timer = setTimeout(() => { serial(() => confirmExit(paneID, reason)).catch(() => {}); }, EXIT_CONFIRM_MS);
                    timer.unref?.();
                    ending.set(paneID, timer);
                    break;
                }
                default:
            }
        },

        /** Panes the host reported removed. A move between workspaces can look like one, so the pane list decides. */
        async onPaneRemoved(paneIDs) {
            const workers = paneIDs.filter(id => newsWorker(store, id));
            if (!workers.length) return;
            let live = new Set();
            try { live = new Set((await api.panes.list()).map(p => p.id)); } catch { /* trust the removal */ }
            for (const paneID of workers) {
                if (live.has(paneID)) continue;
                cancelExit(paneID);
                questions.delete(paneID);
                await exited(paneID, 'pane closed without a result');
            }
        },

        /** One screen read of a pane: `question` is its open question menu, or null. */
        async onScreen(paneID, question) {
            const seen = questions.get(paneID);
            if (question === null) {
                if (seen && ++seen.misses >= MENU_GONE_SCANS) questions.delete(paneID);
                return;
            }
            // The same open menu: a half-drawn screen can show it before (or without) its question line.
            if (seen && (seen.question === question || !question || !seen.question)) {
                seen.question ||= question;
                seen.misses = 0;
                return;
            }
            if (!newsWorker(store, paneID)) return;
            questions.set(paneID, { question, misses: 0 });
            await writeNews(store, paneID, 'blocked', question || 'a question is waiting in its pane');
        },

        dispose() {
            disposed = true;
            for (const paneID of [...ending.keys()]) cancelExit(paneID);
        }
    };
}
