// Text clean-ups the floor policy runs before its rules read a command. Ported unchanged from swarm-it-herdr/lib/policy.mjs, so the two
// stay in step. Each only ever turns text that cannot run anything into a plain word, and leaves anything it cannot follow as written.

/**
 * The Kelpi rules read `{`, `}`, `*`, `?` and `[` anywhere as a brace or glob expansion, so a curl JSON body
 * (`-d '{"query":"{ x }"}'`) was left for the person. A single-quoted body cannot expand, and neither can a double-quoted
 * one with no `$`, backtick or backslash but `\"`; both are swapped for `x` before the never rules read the command.
 * A body starting with `@` names a file to send, so it is kept as written. Credential rules read the original text.
 * A single-quoted jq filter gets the same treatment (`jq -c '{ok, problems}'`).
 * The text is walked with the shell's own quote state: a flag only counts at the top level, after whitespace, so a
 * decoy `-d '` inside another quoted string cannot pair up with a later quote and hide the command between them.
 * Anything this walk cannot follow with certainty (a newline, which ends a command, `$(`, backticks, `$'`, `$"`,
 * heredocs, `#` comments, an unclosed quote) leaves the text unchanged, which only ever leaves more for the person.
 */
export function inertCurlBodies(text) {
    if (!/\b(?:curl|jq)\b|json\.tool/.test(text) || /[\n\r\v\f]|`|\$[('"{]|<<|(?:^|\s)#/.test(text)) return text;
    // A function, alias or PATH change could make `jq` or `curl` anything at all.
    if (/\b(?:alias|function)\b|\b(?:curl|jq|python3?)\s*\(|(?:^|[\s;&|(])(?:PATH|curl|jq|python3?)=/.test(text)) return text;
    // Flags whose value is data for the server or a header or format string for curl, alone (`-d`) or last in a cluster (`-sSd`).
    const flag = /(-(?:[A-Za-z]*[dHwAeub]|-(?:data|data-raw|data-binary|data-ascii|data-urlencode|json|header|write-out|user-agent|referer|cookie|user))(?:[ \t]+|=))/y;
    // A jq filter in single quotes (`jq -c '{ok, problems}'`) is a program for jq, which cannot run a command. Only plain
    // output flags may come before it; `-f`, `-L`, `--arg` and the rest keep the text as written.
    const jq = /(jq(?:[ \t]+(?:-[cCrRsSnMjae]+|--(?:compact-output|raw-output|exit-status|slurp|null-input|sort-keys|tab))){0,6}[ \t]+)(?:'[^']*'|"(?:[^"\\$`]|\\")*")/y;
    // A backslash in double quotes only matters before `$`, a backtick, `"`, `\` or a newline, so `"%{http_code}\n"` is plain text.
    const body = /'(?!@)[^']*'|"(?!@)(?:[^"\\$`]|\\[^$`\n])*"/y;
    // `python3 -m json.tool` pretty-prints JSON from stdin; it reads as the harmless `jq`.
    const pyTool = /python3?(?:\.\d+)?[ \t]+-m[ \t]+json\.tool(?:[ \t]+(?:--(?:sort-keys|no-ensure-ascii|tab|compact|json-lines)|--indent[ \t]+\d))*(?=$|[ \t]*[;|&)])/y;
    const url = /^https?:\/\//;
    // Only a `jq` or `curl` that is itself the command run counts: `ssh host jq …`, `watch jq …` and `xargs curl …` pass
    // their arguments to a shell again, so what is inside their quotes may be a command line.
    const KEYWORDS = new Set(['until', 'while', 'if', 'then', 'do', 'else', 'elif', '!']);
    const plain = /[^\s;|&()'"\\]+(?=$|[\s;|&()])/y;
    let start = true; // the next word is the command word of a simple command
    let curl = false; // the command word of this simple command is curl
    let out = '';
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (/[;|&()]/.test(c)) { start = true; curl = false; out += c; i += 1; continue; }
        if (/\s/.test(c)) { out += c; i += 1; continue; }
        const wordStart = i === 0 || /[\s;|&()]/.test(text[i - 1]);
        if (c === 'p' && wordStart && start) {
            pyTool.lastIndex = i;
            if (pyTool.test(text)) { out += 'jq'; i = pyTool.lastIndex; start = false; continue; }
        }
        if (wordStart && !(c === 'j' && start) && !(c === '-' && curl) && !(c === 'p' && start)) {
            plain.lastIndex = i;
            const word = plain.exec(text)?.[0];
            if (word !== undefined) {
                const isUrl = curl && !start && url.test(word);
                if (!(start && KEYWORDS.has(word))) {
                    if (start && word === 'curl') curl = true;
                    start = false;
                }
                // A URL argument of curl can carry `?`, `[]`, `{}` and `*` (an unquoted `&` already ends the word).
                out += isUrl ? 'https://x' : word; i += word.length; continue;
            }
        }
        if (wordStart && !(start && c === 'j')) start = false;
        if (c === '\\') { out += text.slice(i, i + 2); i += 2; continue; }
        if (c === "'") {
            const end = text.indexOf("'", i + 1);
            if (end < 0) return text;
            const quotedUrl = curl && wordStart && url.test(text.slice(i + 1, end)) && /^$|^[\s;|&)]/.test(text.slice(end + 1, end + 2));
            out += quotedUrl ? "'https://x'" : text.slice(i, end + 1); i = end + 1; continue;
        }
        if (c === '"') {
            let j = i + 1;
            while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
            if (j >= text.length) return text;
            const quotedUrl = curl && wordStart && url.test(text.slice(i + 1, j)) && /^$|^[\s;|&)]/.test(text.slice(j + 1, j + 2));
            out += quotedUrl ? "'https://x'" : text.slice(i, j + 1); i = j + 1; continue;
        }
        if (c === 'j' && wordStart && start) {
            jq.lastIndex = i;
            const m = jq.exec(text);
            start = false;
            if (m) { out += `${m[1]}'x'`; i = jq.lastIndex; continue; }
        }
        if (c === '-' && wordStart && curl && /\s/.test(text[i - 1] ?? '')) {
            flag.lastIndex = i;
            const f = flag.exec(text);
            if (f) {
                body.lastIndex = flag.lastIndex;
                const b = body.exec(text);
                if (b) {
                    out += `${f[1]}'x'`; i = body.lastIndex; continue;
                }
            }
        }
        out += c; i += 1;
    }
    return out;
}

/**
 * Kelpi leaves a word that a variable builds (`ws$n-clean.tgz`), because it cannot know the value. A `for` loop over a plain list of
 * words has known values, so the loop is written out once per value (`for n in 1 2 3; do mv a$n b; done` becomes `mv a1 b`,
 * `mv a2 b`, `mv a3 b`) and the rules read exactly what will run. Only a simple loop is unrolled: up to 20 words made of letters,
 * digits, `.`, `_` and `-`, no nested loop or other control word, no assignment to the variable. Anything else stays as written.
 */
const CONTROL_WORD = /(?<![-\w])(?:for|while|until|do|done|case|esac|if|then|else|elif|fi|select|function|read|unset|eval|mapfile|readarray|getopts)(?![-\w])/;
const FOR_LOOP = /((?:^|[;&|\n])[ \t]*)for[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]+in((?:[ \t]+[A-Za-z0-9_][A-Za-z0-9._-]*)+)[ \t]*;[ \t]*do[ \t]+([^]*?)[ \t]*(?:;|\n)[ \t]*done(?=[ \t]*(?:$|[;&|\n]))/g;
export function unrollLoops(text) {
    if (!/\bfor\b/.test(text)) return text;
    return text.replace(FOR_LOOP, (all, lead, name, list, body) => {
        const items = list.trim().split(/[ \t]+/);
        if (items.length > 20 || CONTROL_WORD.test(body) || /[ \t]-v[ \t]/.test(body)
            || new RegExp(`(?<![\\w$])${name}[ \\t]*\\+?=`).test(body)) return all;
        const use = new RegExp(`\\$\\{${name}\\}|\\$${name}(?![A-Za-z0-9_])`, 'g');
        return lead + items.map(item => body.replace(use, item)).join(' ; ');
    });
}

/**
 * A quoted string whose text cannot run or expand (single-quoted; double-quoted with no `$`, backtick or backslash) is swapped for `x`
 * when it is a git commit message (`-m "…"`, which may span lines) or an argument of `grep` (a pattern like "^(KELPI|HC_)"), because
 * Kelpi's rules read the quotes' contents as newlines, globs, command words or pipes. The text is walked with the shell's own quote
 * state; a segment ends at an unquoted `; & |` or newline. Anything this walk cannot follow with certainty (`$(`, `${`, backticks, `$'`, `$"`,
 * heredocs, any backslash, a `#` comment, an unclosed quote) leaves the text unchanged, which only ever leaves more for the person.
 */
const COMMIT_MESSAGE_HEAD = /^[ \t]*git(?:[ \t]+-C[ \t]+\S+)?[ \t]+commit\b.*[ \t](?:-[A-Za-z]*m|--message)[ \t]+$/;
const GREP_HEAD = /^[ \t]*(?:grep|egrep|fgrep|rg)(?=[ \t]|$)/;
export function inertQuoted(text) {
    if (!/['"]/.test(text) || /<<|`|\$['"({]|\\|\r/.test(text)) return text;
    let out = '';
    let segment = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        // An unquoted `#` at a word start begins a comment, where a quote mark is only text: the walk would pair it with a later quote and hide
        // the line between them from the rules. Such a line is left as written.
        if (c === '#' && (i === 0 || /[\s;&|()]/.test(text[i - 1]))) return text;
        if (c === ';' || c === '&' || c === '|' || c === '\n') { out += c; segment = out.length; continue; }
        if (c !== '"' && c !== "'") { out += c; continue; }
        const end = text.indexOf(c, i + 1);
        if (end < 0) return text;
        const body = text.slice(i + 1, end);
        const head = out.slice(segment);
        const inert = c === "'" || !/\$/.test(body);
        // Only a commit message may span lines; a grep pattern never does (a newline there would be a hidden second command).
        const blank = inert && (COMMIT_MESSAGE_HEAD.test(head) || (GREP_HEAD.test(head) && !body.includes('\n')));
        out += blank ? `${c}x${c}` : `${c}${body}${c}`;
        i = end;
    }
    return out;
}
/**
 * `cat >> file <<'EOF' … EOF` (or `tee`, or `git commit|tag -F - <<'EOF'`, a message read from stdin, or `python3|node - <<'EOF'`, a script read from
 * stdin, which the floor answers as it answers a script file; `bash` and `sh` are never listed): a quoted delimiter means nothing in the body expands or runs, and cat or tee only writes it, so the
 * body and its marker are removed before the floor rules read the text. Nothing may follow the marker but a plain redirect (no pipe, no second
 * command), and the command before it must be cat or tee; a body fed to a shell or interpreter is never removed. No terminator: text unchanged.
 */
export function quietHeredocs(text) {
    const lines = text.split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const heredoc = /^((?:[^<]*?[;&|][ \t]*)?(?:(?:cat|tee|python[0-9.]*|node)\b[^;&|<]*|git(?:[ \t]+-C[ \t]+[^\s;&|<'"`\\#]+)?[ \t]+(?:commit|tag)\b[^;&|<]*[ \t]-F[ \t]+-[ \t]*))<<-?[ \t]*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)")([^\n]*)$/.exec(line);
        const delimiter = heredoc?.[2] ?? heredoc?.[3];
        if (!heredoc || !/^[ \t]*(?:\d?>>?[ \t]*[\w.\/~+-]+[ \t]*|\d>&\d[ \t]*)*$/.test(heredoc[4])) { out.push(line); continue; }
        // The marker must be a real heredoc to the shell: no comment, quote, backtick or backslash before it on this line, and no earlier line that
        // could leave a quote open, continue onto this line, or start another heredoc whose body this line would be (`echo "` … `cat <<'EOF'`).
        if (/['"`\\#]/.test(heredoc[1]) || /['"`\\]|<</.test(out.join('\n'))) { out.push(line); continue; }
        let end = -1;
        for (let j = i + 1; j < lines.length; j += 1) if (lines[j].replace(/^\t+/, '') === delimiter) { end = j; break; }
        if (end < 0) { out.push(line); continue; }
        out.push(`${heredoc[1]}${heredoc[4]}`);
        i = end;
    }
    return out.join('\n');
}

/**
 * Single-quoted arguments of a `grep`, `egrep`, `fgrep` or `rg` segment are patterns, so they are blanked (backslashes inside single quotes
 * are plain text, which `inertQuoted` does not allow). Text with a double quote, backtick, `$(`, heredoc, comment, backslash outside quotes,
 * newline or unclosed quote is returned unchanged; so is every segment whose first word is anything else (`bash -c '…'` still runs).
 */
export function quietGrepPatterns(text) {
    let out = '';
    let segment = '';
    for (let i = 0; i < text.length; i += 1) {
        const c = text[i];
        if (c === "'") {
            const end = text.indexOf("'", i + 1);
            if (end < 0) return text;
            out += /^[ \t]*(?:grep|egrep|fgrep|rg)(?=[ \t]|$)/.test(segment) ? "'x'" : text.slice(i, end + 1);
            segment += 'q';
            i = end;
        } else if (/["`#\\\n\r]/.test(c) || (c === '$' && text[i + 1] === '(') || (c === '<' && text[i + 1] === '<')) return text;
        else {
            out += c;
            segment = /[;|&]/.test(c) ? '' : segment + c;
        }
    }
    return out;
}
