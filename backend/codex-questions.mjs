// Join the existing local daemon; never start a server, turn, or change a thread's permissions.
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

export function createCodexQuestions({ connect = connectCodex, onChange = () => {}, timeoutMs = 5000 } = {}) {
    let socket, initialized, sequence = 0, closed = false;
    const answersWaiting = new Map();
    const calls = new Map(), questions = new Map(), threads = new Map(), subscribed = new Set();
    const changed = () => onChange();
    function clear(error) {
        for (const call of calls.values()) { clearTimeout(call.timer); call.reject(error); }
        for (const answer of answersWaiting.values()) { clearTimeout(answer.timer); answer.reject(error); }
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
                    if (subscribed.has(id)) continue;
                    // Warm resume joins the running thread and replays pending requests; no overrides or turn/start.
                    let result;
                    try { result = await call('thread/resume', { threadId: id, excludeTurns: true }); }
                    catch (error) {
                        // Ephemeral sessions and sessions closed during discovery have no resumable rollout.
                        if (/no rollout found|thread not found/i.test(error.message)) continue;
                        throw error;
                    }
                    threads.set(id, { name: result.thread.name || id, cwd: result.thread.cwd });
                    subscribed.add(id);
                }
                cursor = page.nextCursor;
            } while (cursor);
            changed();
        },
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
