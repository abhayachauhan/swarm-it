import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodexQuestions } from '../backend/codex-questions.mjs';

const item = { id: 'call-questions', type: 'agentMessage', delivery: 'async', text: 'Choose?', questions: [
    { title: 'Which environment?', options: ['Staging', 'Production'] }, { title: 'When?', options: null }
] };
const questionID = index => JSON.stringify(['request_user_input_async', item.id, index]);
const reply = ids => ({ id: `reply-${ids.join(',')}`, type: 'userMessage', content: [{ type: 'text', text:
    `<send_user_message_question_reply>${JSON.stringify(ids.map(questionItemId => ({ questionItemId, question: 'Which environment?', answer: 'Staging' })))}</send_user_message_question_reply>` }] });
class Socket extends EventTarget {
    readyState = 0; sent = []; history = []; failSend = false;
    constructor() { super(); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
    message(message) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); }
    send(raw) {
        const m = JSON.parse(raw); this.sent.push(m);
        let result = {};
        if (m.method === 'thread/loaded/list') result = { data: ['thread-a'] };
        if (m.method === 'thread/resume') result = { thread: { id: 'thread-a', name: 'Queued test', cwd: '/tmp', turns: [], ...(this.threadStatus ? { status: this.threadStatus } : {}) } };
        if (m.method === 'thread/items/list') {
            if (this.historyFailure) { queueMicrotask(() => this.message({ id: m.id, error: { code: -32000, message: this.historyFailure } })); return; }
            this.duringHistory?.(this);
            this.duringHistory = null;
            result = this.pages?.[m.params.cursor || 'first'] || { data: this.history, nextCursor: null };
        }
        if (m.method === 'turn/start') {
            if (this.failSend) { queueMicrotask(() => this.message({ id: m.id, error: { code: -32000, message: 'Input rejected' } })); return; }
            result = { turn: { id: 'answer-turn', status: 'inProgress', items: [] } };
        }
        if (m.method && m.id) queueMicrotask(() => this.message({ id: m.id, result }));
    }
    complete(item) { this.message({ method: 'item/completed', params: { threadId: 'thread-a', turnId: 'turn-a', item } }); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}

async function setup(history = [], options = {}) {
    let socket;
    const bridge = createCodexQuestions({ connect: () => { socket = new Socket(); socket.history = history; Object.assign(socket, options); return socket; }, timeoutMs: 100 });
    await bridge.refresh(); return { bridge, socket };
}

test('live queued questions appear with their native per-question IDs and string options', async () => {
    const { bridge, socket } = await setup();
    try {
        socket.complete(item);
        assert.equal(bridge.list().length, 1);
        assert.deepEqual(bridge.list()[0].questions.map(q => q.id), [questionID(0), questionID(1)]);
        assert.deepEqual(bridge.list()[0].questions[0].options, [{ label: 'Staging' }, { label: 'Production' }]);
        socket.complete(item); assert.equal(bridge.list().length, 1, 'duplicate completion must not duplicate a question');
    } finally { bridge.dispose(); }
});

test('Answer here recovers questions that were already queued before connection', async () => {
    const { bridge } = await setup([{ item, turnId: 'turn-a' }]);
    try { assert.equal(bridge.list().length, 1); assert.equal(bridge.list()[0].questions[0].question, 'Which environment?'); }
    finally { bridge.dispose(); }
});

test('a queued answer uses the native reply envelope as accepted input, and failed delivery keeps the question', async () => {
    const { bridge, socket } = await setup();
    try {
        socket.complete(item);
        const request = bridge.list()[0]; assert.ok(request, 'queued question must be available before submitting');
        const answers = Object.fromEntries(request.questions.map(q => [q.id, { answers: [q.id === questionID(0) ? 'Staging' : 'Tomorrow'] }]));
        socket.failSend = true;
        await assert.rejects(bridge.answer({ ...request, answers }), { message: 'Input rejected' });
        assert.equal(bridge.list().length, 1); assert.equal(bridge.list()[0].questions.length, 2);
        socket.failSend = false;
        assert.deepEqual(await bridge.answer({ ...request, answers }), { ok: true });
        const sent = socket.sent.findLast(m => m.method === 'turn/start');
        assert.deepEqual(Object.keys(sent.params).sort(), ['input', 'threadId']);
        const text = sent.params.input[0].text;
        const replies = JSON.parse(text.slice('<send_user_message_question_reply>'.length, -'</send_user_message_question_reply>'.length));
        assert.deepEqual(replies, [{ questionItemId: questionID(0), question: 'Which environment?', answer: 'Staging' }, { questionItemId: questionID(1), question: 'When?', answer: 'Tomorrow' }]);
        assert.equal(bridge.list().length, 0);
        await assert.rejects(bridge.answer({ ...request, answers }), { message: 'This question is no longer waiting. Refresh questions.' });
    } finally { bridge.dispose(); }
});

test('reply replay removes only answered questions; a normal follow-up clears older queued questions', async () => {
    const { bridge, socket } = await setup([{ item: reply([questionID(0)]), turnId: 'turn-a' }, { item, turnId: 'turn-a' }]);
    try {
        assert.equal(bridge.list().length, 1);
        assert.deepEqual(bridge.list()[0].questions.map(q => q.id), [questionID(1)]);
        socket.complete(reply([questionID(1)])); assert.equal(bridge.list().length, 0);
        socket.complete(item); assert.equal(bridge.list().length, 0, 'replayed completion cannot reopen answered questions');
        socket.complete({ ...item, id: 'new-question' }); assert.equal(bridge.list().length, 1);
        socket.complete({ id: 'follow-up', type: 'userMessage', content: [{ type: 'text', text: 'Proceed with my new request' }] });
        assert.equal(bridge.list().length, 0);
    } finally { bridge.dispose(); }
});


test('history pages recover older queued questions and stop at the latest normal user request', async () => {
    const normal = { id: 'normal', type: 'userMessage', content: [{ type: 'text', text: 'New request' }] };
    const { bridge, socket } = await setup([], { pages: {
        first: { data: [{ item: reply([questionID(0)]), turnId: 'turn-a' }], nextCursor: 'older' },
        older: { data: [{ item, turnId: 'turn-a' }, { item: normal, turnId: 'turn-a' }, { item: { ...item, id: 'obsolete' }, turnId: 'old' }], nextCursor: 'do-not-read' }
    } });
    try {
        assert.deepEqual(bridge.list().map(r => r.questions.map(q => q.id)), [[questionID(1)]]);
        assert.deepEqual(socket.sent.filter(m => m.method === 'thread/items/list').map(m => m.params.cursor), [undefined, 'older']);
    } finally { bridge.dispose(); }
});

test('a live answer during history hydration cannot be undone by replayed question items', async () => {
    const { bridge } = await setup([{ item, turnId: 'turn-a' }], { duringHistory(socket) {
        socket.complete(reply([questionID(0), questionID(1)]));
    } });
    try { assert.deepEqual(bridge.list(), []); } finally { bridge.dispose(); }
});

test('legacy whole-message and singular IDE-prefixed replies dismiss queued questions', async () => {
    for (const id of [item.id, questionID(0)]) {
        const { bridge, socket } = await setup([{ item, turnId: 'turn-a' }]);
        try {
            const payload = { questionItemId: id, question: 'Which environment?', answer: 'Staging' };
            const text = '# Context from my IDE setup:\n\n## My request for Codex:\n<send_user_message_question_reply>' + JSON.stringify(payload) + '</send_user_message_question_reply>';
            socket.complete({ id: 'singular-reply', type: 'userMessage', content: [{ type: 'text', text }] });
            assert.deepEqual(bridge.list().flatMap(r => r.questions.map(q => q.id)), id === item.id ? [] : [questionID(1)]);
        } finally { bridge.dispose(); }
    }
});


test('turn completion clears only that turn, and idle history does not reopen old questions', async () => {
    const { bridge, socket } = await setup();
    try {
        socket.complete(item);
        socket.message({ method: 'turn/completed', params: { threadId: 'thread-a', turn: { id: 'other-turn' } } });
        assert.equal(bridge.list().length, 1);
        socket.message({ method: 'turn/completed', params: { threadId: 'thread-a', turn: { id: 'turn-a' } } });
        assert.deepEqual(bridge.list(), []);
    } finally { bridge.dispose(); }
    const idle = await setup([{ item, turnId: 'finished-turn' }], { threadStatus: { type: 'idle' } });
    try { assert.deepEqual(idle.bridge.list(), []); assert.equal(idle.socket.sent.filter(m => m.method === 'thread/items/list').length, 0); }
    finally { idle.bridge.dispose(); }
});


test('a live question received before Refresh survives its older history boundary', async () => {
    const { bridge, socket } = await setup([], { historyFailure: 'History temporarily unavailable' });
    try {
        socket.complete(item);
        assert.equal(bridge.list().length, 1);
        socket.historyFailure = null;
        socket.history = [{ item, turnId: 'turn-a' }, { item: { id: 'opening-prompt', type: 'userMessage', content: [{ type: 'text', text: 'Original task' }] }, turnId: 'turn-a' }];
        await bridge.refresh();
        assert.equal(bridge.list().length, 1);
        assert.equal(bridge.list()[0].questions.length, 2);
        assert.deepEqual(bridge.warnings(), []);
    } finally { bridge.dispose(); }
});

test('history failure warns and preserves blocking requests; ordinary user messages leave blocking questions alone', async () => {
    const { bridge, socket } = await setup([], { historyFailure: 'History temporarily unavailable' });
    try {
        socket.message({ id: 77, method: 'item/tool/requestUserInput', params: { threadId: 'thread-a', questions: [{ id: 'blocking', question: 'Proceed?' }] } });
        assert.deepEqual(bridge.warnings(), ['Codex questions (Queued test): History temporarily unavailable. Refresh to retry.']);
        socket.complete({ id: 'follow-up', type: 'userMessage', content: [{ type: 'text', text: 'New request' }] });
        assert.deepEqual(bridge.list().map(r => r.requestID), [77]);
        assert.equal(socket.sent.filter(m => m.method === 'turn/start').length, 0);
    } finally { bridge.dispose(); }
});

test('merely mentioning the reply tag is an ordinary history boundary', async () => {
    const mention = { id: 'mention', type: 'userMessage', content: [{ type: 'text', text: 'Review <send_user_message_question_reply> formatting' }] };
    const { bridge, socket } = await setup([], { pages: {
        first: { data: [{ item: mention, turnId: 'turn-b' }], nextCursor: 'obsolete' },
        obsolete: { data: [{ item, turnId: 'turn-a' }], nextCursor: null }
    } });
    try { assert.deepEqual(bridge.list(), []); assert.equal(socket.sent.filter(m => m.method === 'thread/items/list').length, 1); } finally { bridge.dispose(); }
});
