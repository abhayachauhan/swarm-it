// Extract references as data. Never execute a command read from a conversation.
const PULL_URL = /https:\/\/github\.com\/([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)\b/g;
export function pullReferences(text) {
    const found = new Set(), chunks = [];
    const add = (repo, number) => { if (repo.length > 301 || number.length > 20) return; const url = 'https://github.com/' + repo + '/pull/' + number; found.delete(url); found.add(url); };
    const scan = value => {
        chunks.push(value);
        for (const m of value.matchAll(PULL_URL)) add(m[1], m[2]);
        for (const m of value.matchAll(/\b([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)\s*#([1-9]\d*)\b/g)) add(m[1], m[2]);
        for (const m of value.matchAll(/\bgh\s+pr\s+(?:view|diff|checks)\s+["']?([1-9]\d*)\b([^\n;&|]{0,300})/g)) {
            const repo = /(?:--repo(?:=|\s+)|-R\s+)["']?([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)/.exec(m[2]);
            if (repo) add(repo[1], m[1]);
        }
    };
    // Decode JSON strings to handle quoted tool arguments and escaped newlines.
    const visit = (value, depth = 0) => {
        if (depth > 10) return;
        if (typeof value === 'string') { scan(value); if (value.startsWith('{')) { try { visit(JSON.parse(value), depth + 1); } catch {} } }
        else if (Array.isArray(value)) value.forEach(v => visit(v, depth + 1));
        else if (value && typeof value === 'object') Object.values(value).forEach(v => visit(v, depth + 1));
    };
    for (const line of String(text ?? '').split('\n')) { try { visit(JSON.parse(line)); } catch { scan(line); } }
    const owners = new Set([...found].map(url => new URL(url).pathname.split('/')[1]));
    // Short repository references are usable only with one explicit owner in this context.
    // GitHub lookup still has to confirm the inferred URL before supplying any PR facts.
    if (owners.size === 1) {
        const owner = [...owners][0];
        const generic = new Set(['pr','prs','pull','request','requests','issue','issues','case','cases','merge','merged','apply','and','after','before','the','this','that','fix','build','builds','on','in','for','of','from','at','to','by','with','about','behind','no','not','then']);
        for (const value of chunks) for (const m of value.matchAll(/\b([A-Za-z][A-Za-z0-9_.-]{1,100})\s*#([1-9]\d*)\b/g)) {
            const repo = m[1].toLowerCase();
            if (!generic.has(repo)) add(owner + '/' + repo, m[2]);
        }
    }
    return [...found].slice(-8);
}
