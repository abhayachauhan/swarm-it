const RULE = /^\s*[─━]{20,}\s*$/;
const normalize = text => text.replace(/\s+/gu, ' ').trim();

/** Read the last bounded composer, retaining whether every text cell has SGR dim styling. */
export function claudeComposer(text, styled = false) {
    let dim = false;
    const rows = [{ text: '', cells: [] }];
    for (const token of String(text ?? '').matchAll(/\x1b\[[0-?]*[ -/]*[@-~]|\r|\n|[^\x1b\r\n]+/g)) {
        const value = token[0], row = rows.at(-1);
        if (value.startsWith('\x1b[')) {
            if (value.endsWith('m')) {
                // Skip extended color parameters: an RGB component of 2 is not the dim attribute.
                const codes = value.slice(2, -1).split(';').map(Number);
                for (let i = 0; i < codes.length; i++) {
                    const code = codes[i];
                    if (code === 38 || code === 48 || code === 58) { i += codes[i + 1] === 2 ? 4 : codes[i + 1] === 5 ? 2 : 0; continue; }
                    if (code === 0 || code === 22) dim = false;
                    else if (code === 2) dim = true;
                }
            } else if (/^\x1b\[\d*C$/.test(value)) row.text += ' '.repeat(Math.min(1000, Number(value.slice(2, -1)) || 1));
        } else if (value === '\n') rows.push({ text: '', cells: [] });
        else if (value !== '\r') {
            row.text += value;
            for (const char of value) if (!/\s/u.test(char)) row.cells.push({ char, dim });
        }
    }
    const nonempty = rows.filter(row => row.text.trim());
    for (let i = nonempty.length - 1; i > 0; i--) {
        if (!/^\s*❯(?:\s|$)/u.test(nonempty[i].text) || !RULE.test(nonempty[i - 1].text)) continue;
        const end = nonempty.findIndex((row, k) => k > i && RULE.test(row.text));
        if (end < 0 || nonempty.length - end > 5) return null;
        const input = nonempty.slice(i, end);
        const content = normalize(input.map((row, k) => k ? row.text : row.text.replace(/^\s*❯\s*/u, '')).join('\n'));
        const cells = input.flatMap((row, k) => k ? row.cells : row.cells.slice(1));
        return { content, suggestion: styled && cells.length > 0 && cells.every(cell => cell.dim) };
    }
    return null;
}

/** An unchanged dim suggestion at the empty input cursor, never inferred from plain text alone. */
export async function claudeSuggestionRevision(api, paneID, screen) {
    if (!api.terminal.read || !api.terminal.watch || !api.terminal.unwatch) return null;
    const expected = claudeComposer(screen);
    if (!expected?.content) return null;
    let subscription;
    try {
        const before = await api.terminal.read(paneID);
        if (!Number.isSafeInteger(before.revision) || before.cursor?.col !== 2) return null;
        const snapshot = await api.terminal.watch(paneID);
        subscription = snapshot.subscription;
        const composer = claudeComposer(Buffer.from(snapshot.base64, 'base64').toString('utf8'), true);
        if (!composer?.suggestion || composer.content !== expected.content) return null;
        const after = await api.terminal.read(paneID);
        if (after.revision !== before.revision || after.cursor?.col !== 2
            || claudeComposer(after.text)?.content !== expected.content) return null;
        return after.revision;
    } catch { return null; }
    finally { if (subscription) await api.terminal.unwatch(subscription).catch(() => {}); }
}
