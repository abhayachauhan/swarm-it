// Join the existing daemon. Only an explicit answer sends user input; permissions stay unchanged.
import http from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function connectCodex(socketPath = join(process.env.CODEX_HOME || homedir() + '/.codex', 'app-server-control/app-server-control.sock')) {
    // Native WebSocket handles framing, masking and ping/pong. Only HTTP's destination changes to a Unix socket.
    const dispatcher = { dispatch(options, handler) {
        const headers = Array.isArray(options.headers)
            ? Object.fromEntries(options.headers.reduce((pairs, value, i, all) => { if (i % 2 === 0) pairs.push([value, all[i + 1]]); return pairs; }, []))
            : options.headers;
        const request = http.request({ socketPath, path: '/', method: 'GET', headers: { ...headers, connection: 'Upgrade', upgrade: 'websocket' } });
        handler.onConnect(() => request.destroy());
        request.on('upgrade', (response, socket, head) => {
            if (head.length) socket.unshift(head);
            handler.onUpgrade(response.statusCode, response.rawHeaders.map(value => Buffer.from(value)), socket);
        });
        request.on('response', response => { response.resume(); handler.onError(new Error('Codex daemon refused the connection')); });
        request.on('error', error => handler.onError(error));
        request.end();
        return true;
    } };
    return new WebSocket('ws://localhost/', { dispatcher });
}

function parseReply(item) {
    const content = item.content?.filter(i => i.type !== 'skill' && i.type !== 'mention') || [];
    if (content.length !== 1 || content[0].type !== 'text' || typeof content[0].text !== 'string') return null;
    let text = content[0].text.trim();
    if (text.startsWith('# Context from my IDE setup:\n')) text = text.split('\n## My request for Codex:\n').at(-1).trim();
    const prefix = '<send_user_message_question_reply>', suffix = '</send_user_message_question_reply>';
    if (!text.startsWith(prefix) || !text.endsWith(suffix)) return null;
    try {
        const parsed = JSON.parse(text.slice(prefix.length, -suffix.length));
        const list = Array.isArray(parsed) ? parsed : [parsed];
        return list.length && list.every(r => typeof r?.questionItemId === 'string' && typeof r.question === 'string' && typeof r.answer === 'string') ? list : null;
    } catch { return null; }
}

export function createCodexQuestions({ connect = connectCodex, onChange = () => {}, timeoutMs = 5000 } = {}) {
    let socket, initialized, sequence = 0, closed = false;
    const answersWaiting = new Map();
    const historyWarnings = new Map();
    const seenItems = new Set(), answeredIDs = new Set(), hydrating = new Map();
    const calls = new Map(), questions = new Map(), threads = new Map(), subscribed = new Set();
    const changed = () => onChange();
    function clear(error) {
        for (const call of calls.values()) { clearTimeout(call.timer); call.reject(error); }
        for (const answer of answersWaiting.values()) { clearTimeout(answer.timer); answer.reject?.(error); }
        historyWarnings.clear(); seenItems.clear(); answeredIDs.clear(); hydrating.clear();
        answersWaiting.clear(); calls.clear(); questions.clear(); threads.clear(); subscribed.clear(); initialized = null;
        changed();
    }
    const send = message => {
        if (!socket || socket.readyState !== 1) throw new Error('Codex question connection is closed');
        socket.send(JSON.stringify(message));
    };
    function call(method, params) {
        return new Promise((resolve, reject) => {
            const id = `swarm-${++sequence}`;
            const timer = setTimeout(() => { calls.delete(id); reject(new Error(`Codex ${method} timed out`)); }, timeoutMs);
            calls.set(id, { resolve, reject, timer });
            try { send({ id, method, params }); } catch (error) { clearTimeout(timer); calls.delete(id); reject(error); }
        });
    }
    function queuedItem(threadID, item, turnID) {
        if (!item || typeof item.id !== 'string') return;
        const key = `${threadID}:${item.id}`;
        if (seenItems.has(key)) return;
        if (item.type === 'agentMessage' && item.delivery === 'async' && Array.isArray(item.questions)
            && item.questions.length && item.questions.every(q => typeof q?.title === 'string'
                && (!q.options || (Array.isArray(q.options) && q.options.every(o => typeof o === 'string'))))) {
            seenItems.add(key);
            // Older desktop replies identify the whole source message instead of one question.
            const pending = item.questions.map((q, index) => ({
                id: JSON.stringify(['request_user_input_async', item.id, index]), question: q.title,
                options: q.options?.map(label => ({ label }))
            })).filter(q => !answeredIDs.has(`${threadID}:${q.id}`) && !answeredIDs.has(key));
            if (pending.length) questions.set(`async:${key}`, { requestID: `async:${key}`, threadID, turnID, kind: 'queued', itemID: item.id, questions: pending });
        } else if (item.type === 'userMessage') {
            seenItems.add(key);
            const replies = parseReply(item);
            for (const reply of replies || []) answeredIDs.add(`${threadID}:${reply.questionItemId}`);
            for (const [id, q] of questions) if (q.kind === 'queued' && q.threadID === threadID) {
                q.questions = replies ? q.questions.filter(question => !answeredIDs.has(`${threadID}:${question.id}`) && !answeredIDs.has(`${threadID}:${q.itemID}`)) : [];
                if (!q.questions.length) questions.delete(id);
            }
        }
    }
    function finishQueued(threadID, turnID) {
        for (const [id, q] of questions) if (q.kind === 'queued' && q.threadID === threadID && q.turnID === turnID) questions.delete(id);
    }
    async function recoverQueued(threadID) {
        let cursor, boundary = false;
        const history = [];
        do {
            const page = await call('thread/items/list', { threadId: threadID, sortDirection: 'desc', limit: 100, ...(cursor ? { cursor } : {}) });
            for (const { item, turnId } of page.data || []) {
                // The boundary is older than every recovered question; replaying it would clear newer live items.
                if (item.type === 'userMessage' && !parseReply(item)) { boundary = true; break; }
                if (item.type === 'userMessage' || (item.type === 'agentMessage' && item.delivery === 'async')) history.push({ item, turnID: turnId });
            }
            cursor = page.nextCursor;
        } while (cursor && !boundary);
        for (const entry of history.reverse()) queuedItem(threadID, entry.item, entry.turnID);
    }
    function receive(message) {
        if (!message.method && calls.has(message.id)) {
            const pending = calls.get(message.id); calls.delete(message.id); clearTimeout(pending.timer);
            if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
        } else if (message.method === 'item/tool/requestUserInput') {
            const p = message.params;
            if (p && typeof p.threadId === 'string' && Array.isArray(p.questions) && p.questions.length
                && (typeof message.id === 'string' || Number.isSafeInteger(message.id))
                && p.questions.every(q => q && typeof q.id === 'string' && typeof q.question === 'string'
                    && (!q.options || (Array.isArray(q.options) && q.options.every(o => typeof o.label === 'string'))))) {
                questions.set(String(message.id), { requestID: message.id, threadID: p.threadId, questions: p.questions });
                changed();
            }
        } else if (message.method === 'item/completed') {
            const p = message.params;
            if (typeof p?.threadId === 'string') {
                if (hydrating.has(p.threadId)) hydrating.get(p.threadId).push({ item: p.item, turnID: p.turnId });
                else queuedItem(p.threadId, p.item, p.turnId);
                changed();
            }
        } else if (message.method === 'turn/completed') {
            const p = message.params;
            const clearTurn = { endedTurnID: p?.turn?.id };
            if (hydrating.has(p?.threadId)) hydrating.get(p.threadId).push(clearTurn);
            else finishQueued(p?.threadId, clearTurn.endedTurnID);
            changed();
        } else if (message.method === 'serverRequest/resolved') {
            const q = questions.get(String(message.params?.requestId));
            if (q?.threadID === message.params?.threadId) {
                questions.delete(String(q.requestID));
                const answer = answersWaiting.get(String(q.requestID));
                if (answer) { clearTimeout(answer.timer); answersWaiting.delete(String(q.requestID)); answer.resolve({ ok: true }); }
                changed();
            }
        }
    }
    async function ensure() {
        if (closed) throw new Error('Codex question bridge was disposed');
        if (initialized) return initialized;
        initialized = (async () => {
            socket = connect();
            const connection = socket;
            socket.addEventListener('message', event => { try { receive(JSON.parse(event.data)); } catch { /* unrelated malformed event */ } });
            socket.addEventListener('close', () => { if (socket === connection) clear(new Error('Codex question connection closed')); });
            socket.addEventListener('error', () => { if (socket === connection) clear(new Error('Cannot connect to the local Codex daemon')); });
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => { reject(new Error('Codex daemon connection timed out')); socket.close(); }, timeoutMs);
                socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
                socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Cannot connect to the local Codex daemon')); }, { once: true });
            });
            await call('initialize', { clientInfo: { name: 'kelpi_swarm_questions', version: '0.1.0' }, capabilities: { experimentalApi: true } });
            send({ method: 'initialized' });
        })();
        try { await initialized; } catch (error) { socket?.close(); initialized = null; throw error; }
    }
    return {
        async refresh() {
            await ensure();
            let cursor;
            do {
                const page = await call('thread/loaded/list', cursor ? { cursor } : {});
                for (const id of page.data ?? []) {
                    if (subscribed.has(id) && !historyWarnings.has(id)) continue;
                    // Warm resume joins the running thread and replays pending requests; no overrides or turn/start.
                    hydrating.set(id, []);
                    try {
                        if (!subscribed.has(id)) {
                            const result = await call('thread/resume', { threadId: id, excludeTurns: true });
                            threads.set(id, { name: result.thread.name || id, cwd: result.thread.cwd });
                            subscribed.add(id);
                            if (result.thread.status && result.thread.status.type !== 'active') continue;
                        }
                        await recoverQueued(id);
                        historyWarnings.delete(id);
                    } catch (error) {
                        // Keep other sessions and blocking questions usable when one history cannot be read.
                        if (!/no rollout found|thread not found/i.test(error.message)) historyWarnings.set(id, `Codex questions (${threads.get(id)?.name || id}): ${error.message}. Refresh to retry.`);
                    }
                    finally {
                        const live = hydrating.get(id) || [];
                        hydrating.delete(id);
                        for (const entry of live) {
                            if (entry.endedTurnID) finishQueued(id, entry.endedTurnID);
                            else queuedItem(id, entry.item, entry.turnID);
                        }
                    }
                }
                cursor = page.nextCursor;
            } while (cursor);
            changed();
        },
        warnings() { return [...historyWarnings.values()]; },
        connected() { return socket?.readyState === 1 && !!initialized; },
        list() { return [...questions.values()].map(q => ({ ...q, ...threads.get(q.threadID) })); },
        async answer({ requestID, threadID, answers } = {}) {
            const q = questions.get(String(requestID));
            if (!q || q.requestID !== requestID || q.threadID !== threadID || answersWaiting.has(String(requestID))) throw new Error('This question is no longer waiting. Refresh questions.');
            if (!answers || typeof answers !== 'object' || Object.keys(answers).length !== q.questions.length
                || !q.questions.every(question => Object.hasOwn(answers, question.id) && Array.isArray(answers[question.id]?.answers)
                    && answers[question.id].answers.length === 1 && typeof answers[question.id].answers[0] === 'string'
                    && answers[question.id].answers[0].trim().length > 0 && answers[question.id].answers[0].length <= 20000)) {
                throw new Error('Answer every question before sending (maximum 20,000 characters each).');
            }
            if (q.kind === 'queued') {
                const replies = q.questions.map(question => ({ questionItemId: question.id, question: question.question, answer: answers[question.id].answers[0] }));
                const text = `<send_user_message_question_reply>${JSON.stringify(replies)}</send_user_message_question_reply>`;
                // As in Codex's terminal, accepted ordinary input steers active work or starts an idle turn.
                answersWaiting.set(String(requestID), {});
                try {
                    await call('turn/start', { threadId: threadID, input: [{ type: 'text', text }] });
                    queuedItem(threadID, { id: `swarm-answer-${++sequence}`, type: 'userMessage', content: [{ type: 'text', text }] });
                    changed();
                    return { ok: true };
                } finally { answersWaiting.delete(String(requestID)); }
            }
            // The server broadcasts resolved to every client, including the terminal. No answers are logged or persisted.
            return new Promise((resolve, reject) => {
                const key = String(q.requestID);
                const timer = setTimeout(() => { answersWaiting.delete(key); reject(new Error('Codex has not confirmed the answer. Refresh before retrying.')); }, timeoutMs);
                answersWaiting.set(key, { resolve, reject, timer });
                try { send({ id: q.requestID, result: { answers } }); }
                catch (error) { clearTimeout(timer); answersWaiting.delete(key); reject(error); }
            });
        },
        dispose() { closed = true; clear(new Error('Codex question bridge disposed')); socket?.close(); }
    };
}
