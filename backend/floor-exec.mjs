// The floor policy's reading of a command line as a shell would split it: real words with their quotes kept apart, redirections
// taken off, wrappers (sudo, env, bash -c, xargs, ...) looked through. The older token rules in autoapprove.mjs delete quotes and
// split on spaces, so they cannot tell `--value 'a --help b'` from a real option, and they never see a word that a redirection is
// glued to (`terraform</dev/null apply`). This reads each word once, and fails closed: whatever it cannot read with certainty, or
// cannot tell the meaning of, is left for the user when it touches aws, terraform, terragrunt or tofu.
import { NEVER_AUTO_APPROVE as KELPI_RULES } from './kelpi-policy.mjs';
import { AWS_READ_OPS } from './aws-read-ops.mjs';

export const TERRAFORM_RULE = 'terraform apply or destroy';
/** `terraform import`, `state rm`, `taint`, `force-unlock` and the other commands that change state without applying a plan. */
export const STATE_RULE = 'terraform state change';
export const AWS_RULE = 'aws write';
/** `cdk deploy`, `sam deploy`, `docker push` to an ECR host and the other ways to change AWS without the aws CLI. */
export const DEPLOY_RULE = 'aws deploy';
export const SETTINGS_RULE = 'agent settings write';
export const VARIABLE_RULE = 'command word is a variable';
export const PIPED_RULE = 'piped or heredoc into a shell or interpreter';

const TERRAFORM_TOOLS = new Set(['terraform', 'terragrunt', 'tofu']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
/** Words that come before a command without being it: `then terraform apply`, `{ aws s3 rm …; }`. */
const KEYWORDS = new Set(['!', 'if', 'then', 'elif', 'else', 'do', 'while', 'until', '{', 'coproc']);
/** zsh runs `=rm` as rm and the Mac's file names ignore case (`Terraform` is /usr/local/bin/terraform). */
const base = text => String(text).split('/').pop().replace(/^=+/, '').toLowerCase();

// ---------------------------------------------------------------------------------------------------------------- reading words

/**
 * @typedef {{ text: string, dynamic: boolean, glob: boolean, quoted: boolean, spaced: boolean, splittable: boolean }} Word
 *   text: the word with its quotes taken off. dynamic: a `$` expansion, substitution, backtick or process substitution is in it,
 *   so the real word is only known when the shell runs. glob: an unquoted `* ? [ {` is in it. quoted: any quoting at all.
 *   spaced: the word's own text (not what an expansion fills in) holds a space, so it is a sentence and not one bare name.
 *   splittable: an expansion or substitution stands outside double quotes, so what it fills in may split into several words.
 */

/**
 * Split a shell command line into its simple commands, each a list of words (substitutions and subshells inside are read too, as
 * commands of their own). Redirections are taken off the word list. A heredoc body is skipped when its delimiter is quoted (nothing
 * in it runs) and searched for substitutions when it is not. `failed` is true when the text cannot be followed with certainty: an
 * unclosed quote, substitution or heredoc, or nesting deeper than any real command.
 * @returns {{ commands: Word[][], failed: boolean }}
 */
export function lexShell(source) {
    const p = { src: String(source), i: 0, commands: [], failed: false };
    parse(p, null, 0);
    return { commands: p.commands, failed: p.failed };
}

const MAX_DEPTH = 24;
const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;

function parse(p, close, depth) {
    const { src } = p;
    if (depth > MAX_DEPTH) { p.failed = true; p.i = src.length; return; }
    let words = [];
    let cur = null;
    let redirect = null;
    let parens = 0;
    const heredocs = [];
    const add = text => {
        cur ??= { text: '', dynamic: false, glob: false, quoted: false, spaced: false, splittable: false };
        cur.text += text;
        if (/\s/.test(text)) cur.spaced = true;
    };
    const endWord = () => {
        if (!cur) return;
        const word = cur;
        cur = null;
        // `{ …; }`, `[ -f x ]` and `[[ -f x ]]` are shell syntax, not patterns.
        if (word.glob && /^(?:\{|\}|\[\[?|\]\]?)$/.test(word.text)) word.glob = false;
        if (redirect) {
            if (redirect.heredoc) heredocs.push({ delimiter: word.text, quoted: word.quoted, strip: redirect.strip });
            redirect = null;
            return;
        }
        words.push(word);
    };
    const endCommand = () => { endWord(); redirect = null; if (words.length) p.commands.push(words); words = []; };
    // Everything a `$(`, a backtick or a `${` holds is read as commands of its own, in place.
    const nested = (start, kind) => {
        add(''); cur.dynamic = true; cur.splittable = true;
        if (kind === '`') {
            let end = start + 1;
            while (end < src.length && src[end] !== '`') end += src[end] === '\\' ? 2 : 1;
            if (end >= src.length) { p.failed = true; p.i = src.length; return; }
            const body = src.slice(start + 1, end).replace(/\\([`$\\])/g, '$1');
            const sub = { src: body, i: 0, commands: p.commands, failed: false };
            parse(sub, null, depth + 1);
            if (sub.failed) p.failed = true;
            cur.text += src.slice(start, end + 1);
            p.i = end + 1;
        } else if (kind === '$(') {
            p.i = start + 2;
            parse(p, ')', depth + 1);
            cur.text += src.slice(start, p.i);
        } else {
            p.i = start + 2;
            skipBraced(p, depth);
            cur.text += src.slice(start, p.i);
        }
    };
    const readHeredocs = () => {
        for (const h of heredocs) {
            let body = '';
            let found = false;
            while (p.i < src.length) {
                const nl = src.indexOf('\n', p.i);
                const line = src.slice(p.i, nl < 0 ? src.length : nl);
                p.i = nl < 0 ? src.length : nl + 1;
                if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delimiter) { found = true; break; }
                body += `${line}\n`;
            }
            if (!found) { p.failed = true; return; }
            if (!h.quoted) scanBody(p, body, depth);
        }
        heredocs.length = 0;
    };

    while (p.i < src.length && !p.failed) {
        const c = src[p.i];
        if (c === '\n') { endCommand(); p.i += 1; readHeredocs(); continue; }
        if (c === ' ' || c === '\t' || c === '\r') { endWord(); p.i += 1; continue; }
        // A `#` that starts a word is a comment to the end of the line (the older token rules still read its words, which only leaves more).
        if (c === '#' && cur === null) { while (p.i < src.length && src[p.i] !== '\n') p.i += 1; continue; }
        if (c === '\\') {
            if (src[p.i + 1] === '\n') { p.i += 2; continue; }
            add(src[p.i + 1] ?? ''); cur.quoted = true; p.i += 2; continue;
        }
        if (c === "'") {
            const end = src.indexOf("'", p.i + 1);
            if (end < 0) { p.failed = true; break; }
            add(src.slice(p.i + 1, end)); cur.quoted = true; p.i = end + 1; continue;
        }
        if (c === '"') { add(''); cur.quoted = true; p.i += 1; doubleQuoted(p, cur, depth); continue; }
        if (c === '`') { nested(p.i, '`'); continue; }
        if (c === '$') {
            const d = src[p.i + 1];
            if (d === '(') { nested(p.i, '$('); continue; }
            if (d === '{') { nested(p.i, '${'); continue; }
            if (d === "'") {
                let end = p.i + 2;
                while (end < src.length && src[end] !== "'") end += src[end] === '\\' ? 2 : 1;
                if (end >= src.length) { p.failed = true; break; }
                add(src.slice(p.i, end + 1)); cur.dynamic = true; cur.quoted = true; p.i = end + 1; continue;
            }
            if (d === '"') { add(''); cur.quoted = true; p.i += 2; doubleQuoted(p, cur, depth); continue; }
            if (d !== undefined && (NAME_START.test(d) || /[0-9@*#?$!-]/.test(d))) {
                let end = p.i + 2;
                if (NAME_START.test(d)) while (end < src.length && NAME_CHAR.test(src[end])) end += 1;
                add(src.slice(p.i, end)); cur.dynamic = true; cur.splittable = true; p.i = end; continue;
            }
            add('$'); p.i += 1; continue;
        }
        if (c === '<' || c === '>' || (c === '&' && src[p.i + 1] === '>')) {
            if ((c === '<' || c === '>') && src[p.i + 1] === '(') {
                // A process substitution is a word the shell fills in, and a command of its own.
                add(''); cur.dynamic = true;
                const start = p.i;
                p.i += 2;
                parse(p, ')', depth + 1);
                cur.text += src.slice(start, p.i);
                continue;
            }
            // `2>file`: the digits are the operator's file descriptor, not a word.
            if (cur && !cur.quoted && /^[0-9]+$/.test(cur.text)) cur = null; else endWord();
            const op = /^(?:&>>|&>|<<<|<<-|<<|<>|<&|<|>>|>&|>\||>)/.exec(src.slice(p.i, p.i + 3))[0];
            p.i += op.length;
            redirect = { heredoc: op === '<<' || op === '<<-', strip: op === '<<-' };
            continue;
        }
        if (c === ';' || c === '|' || c === '&') { endCommand(); p.i += 1; continue; }
        if (c === '(') { endCommand(); parens += 1; p.i += 1; continue; }
        if (c === ')') {
            endCommand(); p.i += 1;
            if (parens > 0) parens -= 1;
            else if (close === ')') return;
            continue;
        }
        if (c === '*' || c === '?' || c === '[' || c === '{') add(c), cur.glob = true;
        else add(c);
        p.i += 1;
    }
    endCommand();
    if (close !== null && !p.failed) p.failed = true;
}

/** The inside of a double-quoted string: only `$`, backtick and backslash mean anything. Adds to `word` up to the closing quote. */
function doubleQuoted(p, word, depth) {
    const { src } = p;
    while (p.i < src.length) {
        const c = src[p.i];
        if (c === '"') { p.i += 1; return; }
        if (c === '\\') {
            const d = src[p.i + 1] ?? '';
            if (d === '\n') { p.i += 2; continue; }
            word.text += /[$`"\\]/.test(d) ? d : `\\${d}`;
            if (/\s/.test(d)) word.spaced = true;
            p.i += 2; continue;
        }
        if (c === '`') {
            let end = p.i + 1;
            while (end < src.length && src[end] !== '`') end += src[end] === '\\' ? 2 : 1;
            if (end >= src.length) { p.failed = true; p.i = src.length; return; }
            const sub = { src: src.slice(p.i + 1, end).replace(/\\([`$\\])/g, '$1'), i: 0, commands: p.commands, failed: false };
            parse(sub, null, depth + 1);
            if (sub.failed) p.failed = true;
            word.dynamic = true; word.text += src.slice(p.i, end + 1); p.i = end + 1; continue;
        }
        if (c === '$' && src[p.i + 1] === '(') {
            const start = p.i;
            p.i += 2;
            parse(p, ')', depth + 1);
            word.dynamic = true; word.text += src.slice(start, p.i); continue;
        }
        if (c === '$' && src[p.i + 1] === '{') {
            const start = p.i;
            p.i += 2;
            skipBraced(p, depth);
            // `"${@}"`, `"${*:2}"` and `"${list[@]}"` are the one kind of expansion that still makes several words inside double quotes.
            if (/^\$\{[@*]|\[[@*]\]/.test(src.slice(start, p.i))) word.splittable = true;
            word.dynamic = true; word.text += src.slice(start, p.i); continue;
        }
        if (c === '$' && src[p.i + 1] !== undefined && (NAME_START.test(src[p.i + 1]) || /[0-9@*#?$!-]/.test(src[p.i + 1]))) {
            let end = p.i + 2;
            if (NAME_START.test(src[p.i + 1])) while (end < src.length && NAME_CHAR.test(src[end])) end += 1;
            if (src[p.i + 1] === '@' || src[p.i + 1] === '*') word.splittable = true;
            word.dynamic = true; word.text += src.slice(p.i, end); p.i = end; continue;
        }
        word.text += c; p.i += 1;
        if (/\s/.test(c)) word.spaced = true;
    }
    p.failed = true;
}

/** `${…}`: a parameter expansion, which can hold a substitution (`${X:-$(terraform apply)}`). `p.i` is just after the `{`. */
function skipBraced(p, depth) {
    const { src } = p;
    let level = 1;
    while (p.i < src.length) {
        const c = src[p.i];
        if (c === '\\') { p.i += 2; continue; }
        if (c === "'") { const end = src.indexOf("'", p.i + 1); if (end < 0) break; p.i = end + 1; continue; }
        if (c === '"') { p.i += 1; doubleQuoted(p, { text: '' }, depth); continue; }
        if (c === '`') { let end = p.i + 1; while (end < src.length && src[end] !== '`') end += src[end] === '\\' ? 2 : 1; p.i = end + 1; continue; }
        if (c === '$' && src[p.i + 1] === '(') { p.i += 2; parse(p, ')', depth + 1); continue; }
        if (c === '$' && src[p.i + 1] === '{') { p.i += 2; level += 1; continue; }
        if (c === '}') { p.i += 1; level -= 1; if (level === 0) return; continue; }
        p.i += 1;
    }
    p.failed = true;
}

/** An unquoted heredoc body expands like a double-quoted string: read only the substitutions in it as commands. */
function scanBody(p, body, depth) {
    const sub = { src: body, i: 0, commands: p.commands, failed: false };
    while (sub.i < body.length && !sub.failed) {
        const c = body[sub.i];
        if (c === '\\') { sub.i += 2; continue; }
        if (c === '$' && (body[sub.i + 1] === '(' || body[sub.i + 1] === '{')) {
            sub.i += 2;
            if (body[sub.i - 1] === '(') parse(sub, ')', depth + 1); else skipBraced(sub, depth);
            continue;
        }
        if (c === '`') {
            let end = sub.i + 1;
            while (end < body.length && body[end] !== '`') end += body[end] === '\\' ? 2 : 1;
            if (end >= body.length) { sub.failed = true; break; }
            const inner = { src: body.slice(sub.i + 1, end).replace(/\\([`$\\])/g, '$1'), i: 0, commands: p.commands, failed: false };
            parse(inner, null, depth + 1);
            if (inner.failed) sub.failed = true;
            sub.i = end + 1; continue;
        }
        sub.i += 1;
    }
    if (sub.failed) p.failed = true;
}

// ---------------------------------------------------------------------------------------------------------- looking through wrappers

/** Commands that run another command, and the options of theirs that take the next word as a value. */
const WRAPPERS = new Map([
    ['sudo', new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-T', '-U', '-R', '--user', '--group', '--chdir', '--host', '--prompt', '--role', '--type', '--other-user', '--close-from', '--command-timeout'])],
    ['doas', new Set(['-u', '-C'])],
    ['env', new Set(['-u', '-C', '-P', '--unset', '--chdir'])],
    ['nice', new Set(['-n', '--adjustment'])],
    ['ionice', new Set(['-c', '-n', '-p', '-P', '-u', '--class', '--classdata'])],
    ['nohup', new Set()], ['setsid', new Set()], ['command', new Set()], ['builtin', new Set()], ['chronic', new Set()], ['unbuffer', new Set()],
    ['exec', new Set(['-a'])],
    ['time', new Set(['-f', '-o', '--format', '--output'])],
    ['stdbuf', new Set(['-i', '-o', '-e', '--input', '--output', '--error'])],
    ['timeout', new Set(['-s', '-k', '--signal', '--kill-after'])],
    ['caffeinate', new Set(['-t', '-w'])]
]);
const XARGS_VALUES = new Set(['-a', '-d', '-E', '-e', '-I', '-L', '-n', '-P', '-s', '--arg-file', '--delimiter', '--eof', '--max-args', '--max-procs', '--max-lines', '--max-chars']);
const PARALLEL_VALUES = new Set(['-j', '-n', '-N', '-S', '-a', '-P', '-L', '-C', '--jobs', '--max-args', '--sshlogin', '--arg-file', '--colsep', '--delay', '--timeout', '--results', '--joblog']);
const SSH_VALUES = new Set(['-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w']);
const WATCH_VALUES = new Set(['-n', '--interval']);
const SHELL_VALUES = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);
const EXEC_FLAGS = new Set(['-exec', '-execdir', '-ok', '-okdir']);
/** Tools that run what follows a `--` on their command line: `op run -- aws …`, `chamber exec svc -- aws …`. */
const DASHDASH_TOOLS = new Set(['op', 'saml2aws', 'doppler', 'chamber', 'assume', 'granted', 'aws-sso', 'leapp', 'envchain', 'dotenv']);

/**
 * Every command a simple command ends up running, looking through assignments, keywords, wrappers, `bash -c "…"`, `ssh host …`,
 * `watch …`, `aws-vault exec p -- …`, `xargs …`, `find -exec …`. Each result is `{ name, exe, args, stdin }`: the command, its
 * words, and whether xargs, parallel or find supplies more arguments that cannot be read here; or `{ dynamicExe }` for a command
 * word only the shell can fill in.
 */
function invocations(words, out, depth = 0, stdin = false) {
    if (depth > 8) { out.push({ dynamicExe: true, bare: true, stdin }); return; }
    let i = 0;
    for (;;) {
        while (i < words.length && ((ASSIGNMENT.test(words[i].text) && !words[i].quoted) || KEYWORDS.has(words[i].text))) i += 1;
        if (i >= words.length) return;
        const exe = words[i];
        // `bare`: the word begins with the expansion (`$T apply`), as opposed to a word with one inside (JSON such as {"note":"$HOME"}).
        if (exe.dynamic) { out.push({ dynamicExe: true, bare: /^[$`]/.test(exe.text), stdin }); return; }
        const name = base(exe.text);
        const wrapperValues = WRAPPERS.get(name);
        if (wrapperValues) {
            let j = i + 1;
            for (; j < words.length; j += 1) {
                const t = words[j].text;
                if (words[j].dynamic) break;
                if (t === '--') { j += 1; break; }
                if (!t.startsWith('-') || t === '-') break;
                if (name === 'command' && /^-[A-Za-z]*[vV]/.test(t)) return;
                if (wrapperValues.has(t)) j += 1;
            }
            if (name === 'timeout' && j < words.length) j += 1;
            i = j;
            continue;
        }
        const rest = words.slice(i + 1);
        if (SHELLS.has(name)) {
            // `bash -o pipefail -c '…'`: options come first, some with a value of their own; the first word that is not an option is the script.
            let j = 0;
            while (j < rest.length && /^[-+]/.test(rest[j].text) && !rest[j].dynamic) {
                const t = rest[j].text;
                if (/^-[A-Za-z]*c[A-Za-z]*$/.test(t)) {
                    if (rest[j + 1] !== undefined) subCommands(rest[j + 1].text, out, depth + 1, stdin);
                    return;
                }
                j += SHELL_VALUES.has(t) ? 2 : 1;
            }
            // The ordered search stopped on a word it cannot place (a dynamic option, an unknown value option): any `-c` still names the script after it.
            const c = rest.findIndex(w => !w.dynamic && /^-[A-Za-z]*c[A-Za-z]*$/.test(w.text));
            if (c >= 0 && rest[c + 1] !== undefined) { subCommands(rest[c + 1].text, out, depth + 1, stdin); return; }
        } else if (name === 'ssh') {
            let j = 0;
            while (j < rest.length && rest[j].text.startsWith('-')) j += SSH_VALUES.has(rest[j].text) ? 2 : 1;
            if (j + 1 < rest.length) subCommands(rest.slice(j + 1).map(w => w.text).join(' '), out, depth + 1, stdin);
        } else if (name === 'watch') {
            let j = 0;
            while (j < rest.length && rest[j].text.startsWith('-')) j += WATCH_VALUES.has(rest[j].text) ? 2 : 1;
            if (j < rest.length) subCommands(rest.slice(j).map(w => w.text).join(' '), out, depth + 1, stdin);
        } else if (name === 'xargs' || name === 'gxargs') {
            let j = 0;
            while (j < rest.length && rest[j].text.startsWith('-')) j += XARGS_VALUES.has(rest[j].text) ? 2 : 1;
            invocations(rest.slice(j), out, depth + 1, true);
            return;
        } else if (name === 'parallel') {
            let j = 0;
            while (j < rest.length && rest[j].text.startsWith('-')) j += PARALLEL_VALUES.has(rest[j].text) ? 2 : 1;
            invocations(rest.slice(j), out, depth + 1, true);
            // Whatever follows `:::` is read as arguments of that command, so any protected word anywhere is the command.
            for (const w of rest) if (isProtected(base(w.text))) out.push({ name: base(w.text), exe: w, args: [], stdin: true });
            return;
        } else if (name === 'find' || name === 'gfind') {
            for (let k = 0; k < rest.length; k += 1) {
                if (!EXEC_FLAGS.has(rest[k].text)) continue;
                let end = k + 1;
                while (end < rest.length && rest[end].text !== ';' && rest[end].text !== '+') end += 1;
                invocations(rest.slice(k + 1, end), out, depth + 1, true);
                k = end;
            }
        } else if (name === 'aws-vault') {
            const at = rest.findIndex(w => w.text === 'exec');
            if (at >= 0) {
                const dash = rest.findIndex((w, k) => k > at && w.text === '--');
                const positional = rest.findIndex((w, k) => k > at && !w.text.startsWith('-'));
                const from = dash >= 0 ? dash + 1 : positional >= 0 ? positional + 1 : rest.length;
                invocations(rest.slice(from), out, depth + 1, stdin);
            }
            return;
        } else if (DASHDASH_TOOLS.has(name)) {
            const dash = rest.findIndex(w => w.text === '--');
            if (dash >= 0) invocations(rest.slice(dash + 1), out, depth + 1, stdin);
        }
        out.push({ name, exe, args: rest, stdin });
        return;
    }
}

/** A command line held in one string (`bash -c "…"`, what ssh runs remotely): read as commands, and left whole when it cannot be read. */
function subCommands(text, out, depth, stdin) {
    const lexed = lexShell(text);
    if (lexed.failed) { out.push({ unreadable: true, text, stdin }); return; }
    for (const words of lexed.commands) invocations(words, out, depth, stdin);
}

const isProtected = name => name === 'aws' || TERRAFORM_TOOLS.has(name);

// --------------------------------------------------------------------------------------------------------------------- terraform

const TERRAFORM_VERBS = new Set(['apply', 'destroy', 'apply-all', 'destroy-all']);
/** Commands that change state without applying a plan: `import`, `taint`, `untaint`, `force-unlock`, and `state rm|mv|push|replace-provider`. */
const TERRAFORM_STATE_VERBS = new Set(['import', 'taint', 'untaint', 'force-unlock']);
const TERRAFORM_STATE_SUBVERBS = new Set(['rm', 'mv', 'push', 'replace-provider']);
/** Verbs that read or only write a plan: a word the shell fills in after one of these cannot turn the command into an apply. */
const TERRAFORM_SAFE = new Set(['plan', 'validate', 'fmt', 'init', 'show', 'output', 'version', 'providers', 'graph', 'get']);

/** The floor rule an invocation of terraform, terragrunt or tofu breaks, or null. `args` are its words after the tool name. */
function terraformRule(args, stdin) {
    if (stdin) return TERRAFORM_RULE;
    if (args.some(a => !a.dynamic && !a.glob && TERRAFORM_VERBS.has(a.text))) return TERRAFORM_RULE;
    const plain = args.map(a => (a.dynamic || a.glob ? '' : a.text));
    const state = plain.indexOf('state');
    if (plain.some(w => TERRAFORM_STATE_VERBS.has(w)) || (state >= 0 && plain.slice(state + 1).some(w => TERRAFORM_STATE_SUBVERBS.has(w)))) return STATE_RULE;
    if (!args.some(a => a.dynamic || a.glob)) return null;
    // `terraform "$ACTION"` or `terraform $(echo apply)`: the verb is only known when the shell runs it. A plain verb that reads, written
    // out before any word the shell fills in, settles it (`terraform plan -var "x=$X"`).
    const verb = args.findIndex(a => !a.text.startsWith('-') || a.dynamic || a.glob);
    if (verb >= 0 && !args[verb].dynamic && !args[verb].glob && TERRAFORM_SAFE.has(args[verb].text) && args.slice(0, verb).every(a => !a.dynamic && !a.glob)) return null;
    return TERRAFORM_RULE;
}

/** A pull request comment that tells Atlantis (the infrastructure repos' Terraform runner) to apply, import or change state. `atlantis plan` is not one. */
const ATLANTIS_COMMAND = /\batlantis["'\s]+(apply|import|state|[$`])/i;
/**
 * The floor rule an `atlantis apply`, `atlantis import` or `atlantis state` anywhere in the text breaks, or null, and so does `atlantis`
 * followed by a word the shell fills in (`"atlantis $ACTION"`). Read on the raw text, before quotes, heredocs and commit messages are made
 * inert: `gh pr comment 1 --body "atlantis apply"` is a command to Atlantis, whatever tool posts it, so it is also read in every string
 * value of an MCP call. A word spelled around the quotes (`atl""antis apply`) is a disguise, which is outside what the floor guards against.
 */
export function atlantisRule(text) {
    const found = ATLANTIS_COMMAND.exec(String(text));
    if (!found) return null;
    const verb = found[1].toLowerCase();
    return verb === 'import' || verb === 'state' ? STATE_RULE : TERRAFORM_RULE;
}

// ------------------------------------------------------------------------------------------------------ AWS deploys without the aws CLI

/**
 * Tools that change AWS without going through the aws CLI: the words of theirs that deploy, delete or publish, and the words that only
 * read (a word the shell fills in after one of those cannot turn the call into a deploy). Matched as a word anywhere in the arguments, as
 * the terraform verbs are, so `cdk --profile p deploy Stack` and `npx cdk deploy` are caught.
 */
const DEPLOY_TOOLS = new Map([
    ['cdk', { verbs: ['deploy', 'destroy', 'bootstrap', 'watch', 'rollback', 'import'],
        safe: ['synth', 'synthesize', 'diff', 'list', 'ls', 'doctor', 'docs', 'doc', 'context', 'metadata', 'notices', 'version', 'acknowledge', 'ack', 'init', 'flags'] }],
    ['sam', { verbs: ['deploy', 'delete', 'sync', 'package', 'publish'], safe: ['build', 'validate', 'local', 'logs', 'list', 'init', 'traces', 'version'] }],
    ['copilot', { verbs: ['deploy', 'delete'], safe: ['ls', 'show', 'status', 'logs', 'package', 'version', 'help'] }],
    ['eb', { verbs: ['deploy', 'create', 'terminate', 'swap', 'clone'], safe: ['list', 'status', 'events', 'logs', 'open', 'console', 'health', 'printenv', 'use', 'init'] }],
    ['amplify', { verbs: ['publish', 'push', 'delete', 'remove'], safe: ['status', 'help', 'version', 'pull', 'console'] }]
].map(([name, spec]) => [name, { verbs: new Set(spec.verbs), safe: new Set(spec.safe) }]));
/** The deploy tool a word names, or null: the lower-case name, `aws-cdk` as `cdk`, a package version (`aws-cdk@2`) taken off. */
const deployTool = text => {
    const name = base(String(text).replace(/@[^/]*$/, ''));
    return DEPLOY_TOOLS.get(name === 'aws-cdk' ? 'cdk' : name) ?? null;
};
const MENTIONS_DEPLOY = /\b(?:aws-cdk|cdk|sam|copilot|eb|amplify|docker|podman|nerdctl|buildah|finch)\b/i;

/** The floor rule a call of one of those tools breaks, or null. */
function deployToolRule(spec, args, stdin) {
    if (stdin) return DEPLOY_RULE;
    if (args.some(a => !a.dynamic && !a.glob && spec.verbs.has(a.text))) return DEPLOY_RULE;
    if (!args.some(a => a.dynamic || a.glob)) return null;
    const verb = args.findIndex(a => !a.text.startsWith('-') || a.dynamic || a.glob);
    if (verb >= 0 && !args[verb].dynamic && !args[verb].glob && spec.safe.has(args[verb].text) && args.slice(0, verb).every(a => !a.dynamic && !a.glob)) return null;
    return DEPLOY_RULE;
}

const CONTAINER_TOOLS = new Set(['docker', 'podman', 'nerdctl', 'buildah', 'finch']);
/** An Amazon ECR registry: a private one (`123456789012.dkr.ecr.ap-southeast-2.amazonaws.com`) or the public one. */
const ECR_HOST = /\.dkr\.ecr(?:-fips)?\.[a-z0-9-]+\.amazonaws\.com|public\.ecr\.aws/i;
/**
 * A push to Amazon ECR: `docker push`, `docker image push`, `docker buildx build --push` or `--output type=registry` that names an ECR registry,
 * or whose image name the shell fills in (it may be one). A push to any other registry stays approved.
 */
function containerPushRule(args, stdin) {
    // Any value the CLI reads as true counts (`--push=1`, `push=T`, `--push=TRUE`).
    const pushes = args.some(a => !a.dynamic && !a.glob && (a.text === 'push' || /^--push(?:=(?:1|t|true))?$/i.test(a.text) || /type=registry|(?:^|,)push=(?:1|t|true)\b/i.test(a.text)));
    if (!pushes) return null;
    // `compose push` and `buildx bake` take their image names from a file, so no registry shows in the arguments.
    const namesInAFile = args.some(a => !a.dynamic && !a.glob && (a.text === 'compose' || a.text === 'bake'));
    return stdin || namesInAFile || args.some(a => a.dynamic || a.glob || ECR_HOST.test(a.text)) ? DEPLOY_RULE : null;
}

// ------------------------------------------------------------------------------------------------------------------------------ aws

/** Global options of the AWS CLI with no value, and with a value in the next word (or attached with `=`). */
const AWS_FLAGS = new Set(['--debug', '--no-verify-ssl', '--no-paginate', '--no-sign-request', '--no-cli-pager', '--no-cli-auto-prompt', '--cli-auto-prompt', '--version', '--help']);
const AWS_VALUES = new Set(['--endpoint-url', '--output', '--query', '--profile', '--region', '--color', '--ca-bundle', '--cli-read-timeout', '--cli-connect-timeout', '--cli-binary-format']);
const S3_URL = /^s3:\/\//i;
/** A word the shell fills in cannot be an `s3://` URL when what is written before the expansion rules that out: `/tmp/$X`, `./$X`, `~/$X`. */
const surelyLocal = word => /^(?:\/|\.\/|\.\.\/|~)/.test(word.text);

/**
 * The floor rule an `aws` call breaks, or null: only a call that is known to read passes. `args` are the words after `aws`.
 * A service or operation that is not on the AWS CLI's own list of reads, one the shell fills in, or an option this does not know in
 * front of the service, is a write. `--help` and `help` count only in the place the CLI reads them, never inside a value.
 */
function awsRule(args, stdin) {
    if (stdin) return AWS_RULE;
    let i = 0;
    while (i < args.length && args[i].text.startsWith('-')) {
        const word = args[i];
        if (word.dynamic) return AWS_RULE;
        const eq = word.text.indexOf('=');
        const name = eq > 0 ? word.text.slice(0, eq) : word.text;
        if (AWS_FLAGS.has(name)) i += 1;
        else if (AWS_VALUES.has(name)) i += eq > 0 ? 1 : 2;
        else return AWS_RULE;
    }
    if (i >= args.length) return null;
    const words = args.slice(i);
    const [serviceWord, opWord] = words;
    if (serviceWord.dynamic || serviceWord.glob) return AWS_RULE;
    const service = serviceWord.text;
    if (service === 'help') return null;
    if (opWord === undefined) return AWS_RULE;
    if (opWord.text === 'help' || opWord.text === '--help') return null;
    if (opWord.dynamic || opWord.glob || opWord.text.startsWith('-')) return AWS_RULE;
    const op = opWord.text;
    if (words[2] !== undefined && !words[2].dynamic && (words[2].text === '--help' || words[2].text === 'help')) return null;
    if (service === 'configure') return ['list', 'get', 'list-profiles'].includes(op) ? null : AWS_RULE;
    if (service === 'sso' && (op === 'login' || op === 'logout')) return null;
    if (service === 's3') {
        if (op === 'ls' || op === 'presign') return null;
        if (op !== 'cp' && op !== 'sync') return AWS_RULE;
        // A download only: the first operand is the one s3:// URL, the rest are local, and nothing is deleted. A bare `-` is stdin or stdout.
        const rest = words.slice(2);
        if (rest.some(w => w.text.startsWith('--delete'))) return AWS_RULE;
        const operands = rest.filter(w => w.text === '-' || !w.text.startsWith('-'));
        const first = operands[0];
        if (first === undefined || first.dynamic || first.glob || !S3_URL.test(first.text)) return AWS_RULE;
        if (operands.slice(1).some(w => S3_URL.test(w.text) || ((w.dynamic || w.glob) && !surelyLocal(w)))) return AWS_RULE;
        return null;
    }
    if (service === 'mediaconvert' && op === 'describe-endpoints') return mediaConvertEndpointsRule(words.slice(2));
    const known = AWS_READ_OPS.get(service);
    if (known === undefined) return AWS_RULE;
    return op === 'wait' || known.has(op) ? null : AWS_RULE;
}

/**
 * `mediaconvert describe-endpoints` creates the account's endpoint when there is none, in the default mode and when no mode is given;
 * only `--mode GET_ONLY` cannot. So it passes when that is written out, once or more and never with another value, and nothing else
 * could change it: an input JSON or YAML file (or any option this does not know) may carry a different mode, so those are left.
 */
function mediaConvertEndpointsRule(rest) {
    let getOnly = false;
    for (let i = 0; i < rest.length; i += 1) {
        const word = rest[i];
        if (word.dynamic || word.glob) return AWS_RULE;
        const eq = word.text.indexOf('=');
        const name = eq > 0 ? word.text.slice(0, eq) : word.text;
        if (name === '--mode') {
            const value = eq > 0 ? { text: word.text.slice(eq + 1), dynamic: false } : rest[i + 1];
            if (value === undefined || value.dynamic || value.text !== 'GET_ONLY') return AWS_RULE;
            getOnly = true;
            if (eq < 0) i += 1;
        } else if (AWS_VALUES.has(name)) {
            if (eq < 0) i += 1;
        } else if (!AWS_FLAGS.has(name)) return AWS_RULE;
    }
    return getOnly ? null : AWS_RULE;
}

// ---------------------------------------------------------------------------------------------------------------- the rest of the floor

/** Commands whose arguments are plain text or file names, so an `aws` or `terraform` among them is a word, not a command. */
const PLAIN_TEXT = new Set(['grep', 'egrep', 'fgrep', 'rg', 'echo', 'printf', 'cat', 'head', 'tail', 'wc', 'ls', 'cd', 'man', 'which', 'type', 'test', 'stat', 'du', 'diff',
    'git', 'gh', 'cp', 'mv', 'rm', 'ln', 'mkdir', 'rmdir', 'touch', 'chmod', 'chown', 'tar', 'zip', 'unzip', 'open', 'code', 'vim', 'nvim', 'vi', 'nano', 'less', 'more',
    'sed', 'awk', 'sort', 'uniq', 'cut', 'tr', 'tee', 'jq', 'yq', 'tree', 'find', 'gfind', 'rsync', 'scp', 'file', 'basename', 'dirname', 'realpath', 'readlink', 'pwd', 'true', 'false']);
const SERVICES_WITH_RULES = new Set(['s3', 'configure', 'sso']);
const PROGRAM_OPTIONS = new Set(['--pre', '--hostname-bin']);

/**
 * `claude` and `codex` subcommands that write the agent's own settings (MCP servers, plugins, config), which stay with the user as
 * a settings write whoever asks. `kelpi install-hooks` is caught by Kelpi's own rule (see kelpiFloorRule).
 */
function agentSettingsRule(name, args) {
    if (name !== 'claude' && name !== 'codex') return null;
    if (args.slice(0, 3).some(a => a.dynamic)) return SETTINGS_RULE;
    // Global options come before the subcommand, some with a value in the next word: `claude --settings /tmp/x.json mcp add …`. Read
    // them with their values, so the subcommand is the first word that is neither.
    const values = AGENT_VALUE_OPTIONS[name];
    const flags = AGENT_FLAGS[name];
    let unknown = false;
    let i = 0;
    // An option value the shell fills in can be several words (`--model $M` with M="x config set", `--model "$@"`), which shifts the subcommand,
    // and there are too many ways to write one to tell the harmless ones apart: any such value leaves the line.
    for (; i < args.length && args[i].text.startsWith('-'); i += 1) {
        const text = args[i].text;
        const eq = text.indexOf('=');
        const option = eq > 0 ? text.slice(0, eq) : text;
        if (eq > 0) { if (args[i].dynamic) return SETTINGS_RULE; continue; }
        if (flags.has(option)) continue;
        if (values.has(option)) {
            if (args[i + 1]?.dynamic) return SETTINGS_RULE;
            i += 1;
        } else unknown = true;
    }
    const rest = args.slice(i);
    if (nameFilledIn(rest[0])) return SETTINGS_RULE;
    if (!unknown) return agentSubcommandRule(name, rest, 0);
    // An option this does not know may or may not take a value, so the subcommand could be any word after it: leave the line when one
    // of them starts a settings write, or may become a subcommand name once the shell fills it in.
    for (let k = 0; k < rest.length; k += 1) {
        if (nameFilledIn(rest[k])) return SETTINGS_RULE;
        const rule = agentSubcommandRule(name, rest, k);
        if (rule) return rule;
    }
    return null;
}
/**
 * A word the shell fills in that could become a bare subcommand or verb: one with no spaces of its own (`$SUB`, `"$SUB"`, `$(echo mcp)`), or one
 * whose expansion can split into several words even with a space beside it (`$SUB" "`). Not a sentence with its expansions quoted (`"Review $FILE now"`).
 */
const nameFilledIn = word => word !== undefined && word.dynamic && (word.splittable || !word.spaced);
/** Global options of `claude` and `codex` that take a value, and the ones that take none. Any other option may be either. */
const AGENT_VALUE_OPTIONS = {
    claude: new Set(['--settings', '--model', '--add-dir', '--mcp-config', '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--tools',
        '--permission-mode', '--append-system-prompt', '--system-prompt', '--session-id', '--fallback-model', '--output-format', '--input-format', '--max-turns', '--agents',
        '--agent', '--plugin-dir', '--setting-sources', '--betas', '--permission-prompt-tool', '--effort', '--name', '-n', '--file', '--max-budget-usd', '--json-schema']),
    codex: new Set(['-c', '--config', '-m', '--model', '-p', '--profile', '-C', '--cd', '-s', '--sandbox', '-a', '--ask-for-approval', '-i', '--image', '--add-dir', '--color',
        '--enable', '--disable', '--local-provider', '--oss-provider'])
};
const AGENT_FLAGS = {
    claude: new Set(['-p', '--print', '-c', '--continue', '--verbose', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--strict-mcp-config',
        '--include-partial-messages', '--replay-user-messages', '--fork-session', '--no-session-persistence', '--chrome', '--no-chrome', '--ide', '--bare', '-v', '--version',
        '-h', '--help', '--disable-slash-commands']),
    codex: new Set(['--oss', '--full-auto', '--dangerously-bypass-approvals-and-sandbox', '--search', '--no-alt-screen', '-h', '--help', '-V', '--version'])
};
const MCP_WRITES = ['add', 'add-json', 'add-from-claude-desktop', 'remove', 'reset-project-choices', 'login', 'logout'];
const PLUGIN_WRITES = ['install', 'uninstall', 'enable', 'disable', 'update', 'marketplace'];
/**
 * The settings write that starts at `rest[k]`: `config`, or `mcp` or `plugin` with a verb that writes anywhere after it (options and their
 * values may stand between, so no fixed window), or a verb word the shell fills in.
 */
function agentSubcommandRule(name, rest, k) {
    const first = rest[k]?.text;
    if (name === 'claude' && first === 'config') return SETTINGS_RULE;
    const verbs = first === 'mcp' ? MCP_WRITES : name === 'claude' && (first === 'plugin' || first === 'plugins') ? PLUGIN_WRITES : null;
    return verbs && rest.slice(k + 1).some(w => nameFilledIn(w) || verbs.includes(w.text)) ? SETTINGS_RULE : null;
}

/** `strict` is false for a string that is probably data (JSON, prose) and not a command line: a command word the shell would have to fill in then proves nothing. */
function invocationRule(inv, strict, source) {
    if (inv.unreadable) return unreadableRule(inv.text, strict);
    // A command word the shell fills in: in data, only when it starts with the expansion and a protected tool is named in the same string.
    if (inv.dynamicExe) return strict || (inv.bare && MENTIONS_TOOL.test(source)) ? VARIABLE_RULE : null;
    // `/usr/local/bin/a?s s3 rm`: a pattern in the command word expands to whatever file matches it.
    if (inv.exe.glob && strict) return 'shell expansion builds a word';
    const { name, args, stdin } = inv;
    if (name === 'aws') return awsRule(args, stdin);
    if (TERRAFORM_TOOLS.has(name)) return terraformRule(args, stdin);
    // A deploy tool that reads (`cdk synth`) is read on for the rest: its arguments may still hold a command (`cdk synth --app "aws s3 rm …"`).
    const deploy = deployTool(inv.exe.text);
    if (deploy) {
        const rule = deployToolRule(deploy, args, stdin);
        if (rule) return rule;
    }
    if (CONTAINER_TOOLS.has(name)) {
        const push = containerPushRule(args, stdin);
        if (push) return push;
    }
    const settings = agentSettingsRule(name, args);
    if (settings) return settings;
    const literal = literalProgramRule(inv);
    if (literal) return literal;
    // `rg --pre terraform x apply` runs `terraform apply` on the searched file, whatever the pattern looks like.
    for (let k = 0; k < args.length; k += 1) {
        const eq = args[k].text.indexOf('=');
        const option = eq > 0 ? args[k].text.slice(0, eq) : args[k].text;
        if (!PROGRAM_OPTIONS.has(option)) continue;
        const value = eq > 0 ? { text: args[k].text.slice(eq + 1), dynamic: args[k].dynamic } : args[k + 1];
        if (!value) continue;
        if (value.dynamic) return VARIABLE_RULE;
        if (base(value.text) === 'aws') return AWS_RULE;
        if (TERRAFORM_TOOLS.has(base(value.text))) return TERRAFORM_RULE;
    }
    if (PLAIN_TEXT.has(name)) return null;
    // A command not named here (`docker run x aws …`, `somewrapper aws …`): an `aws` or `terraform` word among its arguments may be the real
    // command, and a quoted argument that names one may be a command line the tool runs (`docker run x sh -c "aws …"`).
    for (let k = 0; k < args.length; k += 1) {
        if (args[k].quoted && /\s/.test(args[k].text)) {
            if (!MENTIONS_TOOL.test(args[k].text) && !MENTIONS_DEPLOY.test(args[k].text)) continue;
            const inner = lexShell(args[k].text);
            if (inner.failed) {
                const unreadable = unreadableRule(args[k].text, strict);
                if (unreadable) return unreadable;
                continue;
            }
            for (const words of inner.commands) {
                const found = [];
                invocations(words, found, 1);
                for (const nested of found) {
                    const rule = invocationRule(nested, strict, args[k].text);
                    if (rule) return rule;
                }
            }
            continue;
        }
        const word = base(args[k].text);
        if (word === 'aws') {
            const next = args[k + 1];
            if (next === undefined) continue;
            // An option may stand between `aws` and the service (`--profile p ec2 …`), so only a plain word that is no service says it is not a call.
            if (!next.text.startsWith('-') && !next.dynamic && args[k + 2] === undefined) continue;
            if (!next.text.startsWith('-') && !next.dynamic && !AWS_READ_OPS.has(next.text) && !SERVICES_WITH_RULES.has(next.text)) continue;
            const rule = awsRule(args.slice(k + 1), stdin);
            if (rule) return rule;
        } else if (TERRAFORM_TOOLS.has(word) && args[k].text === args[k].text.toLowerCase()) {
            const rule = terraformRule(args.slice(k + 1), stdin);
            if (rule) return rule;
        } else if (args[k].text === args[k].text.toLowerCase() && deployTool(args[k].text)) {
            // `npx cdk deploy`, `pnpm dlx aws-cdk@2 deploy`, `docker run img sam deploy`.
            const rule = deployToolRule(deployTool(args[k].text), args.slice(k + 1), stdin);
            if (rule) return rule;
        }
    }
    return null;
}
const MENTIONS_TOOL = /\b(?:aws|terraform|terragrunt|tofu)\b/i;
/** A quoted string literal that is exactly one of the programs, or the path to it: `'terraform'`, `"aws"`, `` `/usr/local/bin/tofu` ``, `'cdk'`. */
const LITERAL_PROGRAM = /(["'`])(?:[^"'`]*\/)?(aws|terraform|terragrunt|tofu|aws-cdk|cdk|sam|copilot|eb|amplify)\1/i;
/** The floor rule a call of the program named `name` (one that LITERAL_PROGRAM finds) is left under. */
export function programNameRule(name) {
    const program = String(name).toLowerCase();
    return program === 'aws' ? AWS_RULE : TERRAFORM_TOOLS.has(program) ? TERRAFORM_RULE : DEPLOY_RULE;
}
/**
 * Code handed to an interpreter (`node -e`, `python3 -c`, `ruby -e`, `deno eval`) that spells the program out as a string, as in
 * `spawnSync('terraform', ['apply'])` or `subprocess.run(("aws", "s3", "rm", …))`: the argument list is not words the shell can see, so the
 * program's name alone leaves the call. The deploy tools count too (`spawnSync('cdk', ['deploy'])`).
 */
function literalProgramRule(inv) {
    if (!INTERPRETER_NAMES.test(inv.name)) return null;
    const literal = inv.args.map(a => LITERAL_PROGRAM.exec(a.text)?.[2]).find(Boolean);
    return literal === undefined ? null : programNameRule(literal);
}
/** The rule an interpreter call in the command breaks by naming the program as a string, or null. Read before the settings rule, whose
 *  glob reading of `['apply']` would otherwise leave the same call under the wrong name. */
export function interpreterProgramRule(source) {
    const lexed = lexShell(source);
    if (lexed.failed) return null;
    for (const words of lexed.commands) {
        const found = [];
        invocations(words, found);
        for (const inv of found) {
            const rule = inv.unreadable || inv.dynamicExe ? null : literalProgramRule(inv);
            if (rule) return rule;
        }
    }
    return null;
}
/** A string that cannot be read as shell: a command line that names a protected tool is left (in data, only one that starts as a call to it). */
function unreadableRule(text, strict) {
    if (strict ? !MENTIONS_TOOL.test(text) : !text.split(/[;&|\n(]+/).some(part => STARTS_AS_TOOL.test(part))) return null;
    return /\baws\b/i.test(text) ? AWS_RULE : TERRAFORM_RULE;
}
/** A string that starts as a call to one of them (after assignments or sudo), so that when it cannot be read it is still a command, not prose. */
const STARTS_AS_TOOL = /^\s*(?:(?:[A-Za-z_]\w*=\S*|sudo|doas|env|nohup|time|command|exec)\s+)*(?:\S*\/)?(?:aws|terraform|terragrunt|tofu)(?:\s|$)/i;

/**
 * The floor rule a command line breaks when read word by word, or null. Called on the command with only heredoc bodies of cat and
 * tee removed; the older token rules read the same command separately. A line that cannot be read is left when it names aws or
 * terraform at all, unless `strict` is false (a string field of an MCP call, which is data more often than a command line: then only
 * a call to aws, terraform, terragrunt, tofu or the agent's own settings counts, never a command word that merely looks unreadable).
 */
export function floorExecRule(source, strict = true) {
    const lexed = lexShell(source);
    if (lexed.failed) return unreadableRule(source, strict);
    for (const words of lexed.commands) {
        const found = [];
        invocations(words, found);
        for (const inv of found) {
            const rule = invocationRule(inv, strict, source);
            if (rule) return rule;
        }
    }
    return null;
}

const INTERPRETER_NAMES = /^(?:python[0-9.]*|node|nodejs|perl|ruby|php|deno|bun)$/;
/** Commands that only read, list, copy, stage or edit a file they are given, so handing them a script does not run it (awk and sed can: `awk -f`). */
const FILE_HANDLERS = new Set([...PLAIN_TEXT].filter(name => name !== 'awk' && name !== 'sed'));
/**
 * Whether a command line runs or sources a file: a shell or interpreter given something that is not an option (`bash p.sh`, `sh -x p.sh`,
 * `python3 p.py`), `source` or `.`, a command that is itself a path (`./p.sh`, `/tmp/p.sh`), or any command that is not a plain reader or
 * stager (cat, ls, git, cp, ...) and is handed one of `targets`, the files just written, by path or by name (`make -f p.mk`, `crontab p`).
 * Read through wrappers, `bash -c` and `xargs`. A line that cannot be read, or whose command word the shell fills in, counts as running
 * one. Used to tell a script that is only stored (`cat > p.sh <<'EOF'`) from one that is then run, whose body is shell the floor must read.
 */
export function runsFile(source, targets = []) {
    const lexed = lexShell(source);
    if (lexed.failed) return true;
    const calls = [];
    for (const words of lexed.commands) invocations(words, calls);
    // A copy, move or link of a written file gives it other names (`cp p.sh q.sh`), which count as the file from then on.
    const names = [...targets];
    const same = (word, name) => word === name || base(word) === base(name);
    for (let pass = 0; pass < 3; pass += 1) {
        for (const { name, args } of calls) {
            if (!COPIERS.has(name)) continue;
            const operands = args.filter(a => !a.text.startsWith('-')).map(a => a.text);
            if (operands.some(o => names.some(n => same(o, n)))) for (const o of operands) if (!names.includes(o)) names.push(o);
        }
    }
    for (const inv of calls) {
        if (inv.unreadable || inv.dynamicExe) return true;
        const { name, exe, args } = inv;
        if (name === 'source' || exe.text === '.' || exe.text.includes('/') || names.some(n => same(exe.text, n))) return true;
        if ((SHELLS.has(name) || INTERPRETER_NAMES.test(name)) && args.some(a => !a.text.startsWith('-'))) return true;
        if (!FILE_HANDLERS.has(name) && args.some(a => names.some(n => same(a.text, n)))) return true;
    }
    return false;
}
const COPIERS = new Set(['cp', 'mv', 'ln', 'install', 'rsync', 'scp']);

// ------------------------------------------------------------------------------------------------------------------------- Kelpi's rules

/**
 * A redirection operator glued to the word before it (`kelpi>/dev/null`, `cat<in`, `a&>b`), but not a file descriptor's own digits
 * (`2>&1`): the operator is spaced off, its target stays attached. Kelpi's own, copied: kelpi-policy.mjs does not export it.
 */
const GLUED = /(?=&?[<>])(?<=[^\s<>&])(?<!(?:^|[\s;&|()])[0-9]+)&?(?:<<<|<<-?|<>|>>|>\||[<>])/g;
const spaced = form => form.replace(GLUED, ' $&');
/** The same four readings of a command as Kelpi's `segments`, each also with glued redirections spaced off. */
function kelpiSegments(text) {
    const dollars = text.replace(/\$(?=["'])/g, '');
    const redirections = dollars.replace(/([<>])&|&(?=>)/g, '$1').replace(/>\|/g, '>');
    const substitutions = redirections.replace(/\$\(/g, '$ ').replace(/\)/g, ' ').replace(/`([^`]*)`?/g, '$ $1 ');
    const forms = [dollars, text, redirections, substitutions];
    return [...new Set([...forms, ...forms.map(spaced)])].flatMap(form => form
        .replace(/["'\\]/g, '')
        .split(/&&|\|\||[;|&\n`]|\$\(|[()]/)
        .map(segment => segment.trim().split(/\s+/).filter(Boolean))
        .filter(tokens => tokens.length > 0));
}
const KELPI_FLOOR = ['piped or heredoc into a shell or interpreter', 'kelpi install-hooks']
    .map(name => KELPI_RULES.find(rule => rule.name === name))
    .filter(Boolean);
if (KELPI_FLOOR.length !== 2) throw new Error('kelpi-policy.mjs no longer has the rules the floor reuses');

/**
 * Kelpi's own rules for code fed to a shell or interpreter on stdin (`curl … | sh`, `bash < file`, `python3 <<EOF`) and for
 * `kelpi install-hooks`, run on the readings of the command Kelpi uses. Returns the floor rule name or null.
 */
export function kelpiFloorRule(command) {
    const lines = command.split('\n').map(line => line.trim());
    for (const text of new Set([command, lines.join(' '), lines.join('')])) {
        for (const tokens of kelpiSegments(text)) {
            // Kelpi's wrappers stop at sudo, and the floor's stop at `command`: read the line past every wrapper in any order, so
            // `… | sudo bash`, `… | command sudo bash` and `… | nice sudo sh` are all `bash` or `sh`.
            const at = commandIndex(tokens);
            const bare = at > 0 ? tokens.slice(at) : null;
            for (const rule of KELPI_FLOOR) if (rule.test(tokens, text) || (bare && rule.test(bare, text))) return rule.name === 'kelpi install-hooks' ? SETTINGS_RULE : PIPED_RULE;
        }
    }
    return null;
}
/** Every word that runs the rest of its line, standard ones and privilege ones (`pkexec` as well), which may come in any order. */
const WRAPPER_NAMES = new Set([...WRAPPERS.keys(), 'pkexec']);
/**
 * Where the command word is in the tokens of one segment: past assignments and any run of wrappers with their options, whatever the
 * order (`command sudo bash`, `sudo command env bash`, `nice sudo sh`, `env A=1 timeout 5 sudo -u x bash`). -1 when nothing is run
 * (`command -v bash` only looks the word up).
 */
export function commandIndex(tokens) {
    let i = 0;
    for (;;) {
        while (i < tokens.length && ASSIGNMENT.test(tokens[i])) i += 1;
        if (i >= tokens.length) return -1;
        const name = base(tokens[i]);
        if (!WRAPPER_NAMES.has(name)) return i;
        const values = WRAPPERS.get(name);
        i += 1;
        while (i < tokens.length && tokens[i].startsWith('-') && tokens[i] !== '-') {
            if (name === 'command' && /^-[A-Za-z]*[vV]/.test(tokens[i])) return -1;
            i += values?.has(tokens[i]) ? 2 : 1;
        }
        if (name === 'timeout' && i < tokens.length) i += 1;
    }
}
