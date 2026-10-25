import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodexQuestions } from '../backend/codex-questions.mjs';

class Socket extends EventTarget {
    readyState = 0;
    sent = [];
    constructor() { super(); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
    message(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
    send(raw) {
        const m = JSON.parse(raw); this.sent.push(m);
        if ('result' in m && this.resolveAnswers !== false) queueMicrotask(() => this.message({ method: 'serverRequest/resolved', params: { threadId: 'thread-a', requestId: m.id } }));
        if (m.method === 'initialize') queueMicrotask(() => this.message({ id: m.id, result: {} }));
        if (m.method === 'thread/items/list') queueMicrotask(() => this.message({ id: m.id, result: { data: [] } }));
        if (m.method === 'thread/loaded/list') queueMicrotask(() => this.message({ id: m.id, result: { data: ['thread-a'] } }));
        if (m.method === 'thread/resume') queueMicrotask(() => {
            this.message({ id: m.id, result: { thread: { name: 'A test', cwd: '/tmp' } } });
            this.message({ id: 17, method: 'item/tool/requestUserInput', params: { threadId: 'thread-a', questions: [{ id: 'choice', question: 'Which option?', options: [{ label: 'One', description: 'First' }] }] } });
        });
    }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}

test('joins loaded sessions without overrides, accepts one explicit answer and rejects duplicates or wrong threads', async () => {
    let socket;
    const bridge = createCodexQuestions({ connect: () => (socket = new Socket()) });
    try {
        await bridge.refresh();
        assert.equal(bridge.list()[0].name, 'A test');
        assert.deepEqual(socket.sent.find(m => m.method === 'thread/resume').params, { threadId: 'thread-a', excludeTurns: true });
        const answer = { requestID: 17, threadID: 'thread-a', answers: { choice: { answers: ['Custom clarification'] } } };
        await assert.rejects(() => bridge.answer({ ...answer, threadID: 'wrong' }), /no longer waiting/);
        await assert.rejects(() => bridge.answer({ ...answer, answers: { choice: { answers: ['  '] } } }), /Answer every/);
        await assert.rejects(() => bridge.answer({ ...answer, answers: { choice: { answers: ['ok'] }, extra: { answers: ['wrong'] } } }), /Answer every/);
        assert.equal(socket.sent.filter(m => 'result' in m).length, 0);
        assert.deepEqual(await bridge.answer(answer), { ok: true });
        assert.deepEqual(socket.sent.at(-1), { id: 17, result: { answers: answer.answers } });
        await assert.rejects(() => bridge.answer(answer), /no longer waiting/);
    } finally { bridge.dispose(); }
});

test('terminal resolution and disconnect remove stale questions; unrelated resolution does not', async () => {
    let socket;
    const bridge = createCodexQuestions({ connect: () => (socket = new Socket()) });
    try {
        await bridge.refresh();
        socket.message({ method: 'serverRequest/resolved', params: { threadId: 'other', requestId: 17 } });
        assert.equal(bridge.list().length, 1);
        socket.message({ method: 'serverRequest/resolved', params: { threadId: 'thread-a', requestId: 17 } });
        assert.equal(bridge.list().length, 0);
        socket.message({ id: 18, method: 'item/tool/requestUserInput', params: { threadId: 'thread-a', questions: [{ id: 'secret', question: 'Secret?', isSecret: true }] } });
        assert.equal(bridge.list().length, 1);
        socket.close(); assert.equal(bridge.list().length, 0);
    } finally { bridge.dispose(); }
});

test('an unavailable daemon fails with a bounded timeout', async () => {
    const bridge = createCodexQuestions({ connect: () => ({ readyState: 0, addEventListener() {}, close() {} }), timeoutMs: 10 });
    await assert.rejects(bridge.refresh(), /timed out/); bridge.dispose();
});


test('an answer needs server confirmation; timeout retains the question and disconnect rejects a pending send', async () => {
    let socket;
    const bridge = createCodexQuestions({ connect: () => (socket = new Socket()), timeoutMs: 15 });
    try {
        await bridge.refresh(); socket.resolveAnswers = false;
        const answer = { requestID: 17, threadID: 'thread-a', answers: { choice: { answers: ['One'] } } };
        const first = bridge.answer(answer);
        await assert.rejects(bridge.answer(answer), /no longer waiting/);
        await assert.rejects(first, /not confirmed/);
        assert.equal(bridge.list().length, 1);
        const second = bridge.answer(answer); socket.close();
        await assert.rejects(second, /connection closed/);
        assert.equal(bridge.list().length, 0);
    } finally { bridge.dispose(); }
});
