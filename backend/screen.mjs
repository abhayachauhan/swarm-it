// What a captured agent pane is showing. Used before typing into a pane or closing it, and for worker news.
import { parsePrompt, parseCodexPrompt } from './notify.mjs';

export const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const RULE = /^\s*[─━]{20,}\s*$/;
const INPUT = /^\s*❯(?:\s|$)/;
const MENU_OPTION = /^\s*❯\s*\d+[.)]\s/;
const QUESTION_FOOTER = /Enter to select.*Esc to cancel/i;
const WORKING = /(?:esc|ctrl\+c) to interrupt/i;
const BACKGROUND = /\bWaiting for \d+ background|\b\d+ background (?:agent|task)s? (?:running|still)/i;
/** Common shell prompts. A line such as `Context left: 45%` does not match. */
const SHELL_PROMPTS = [
    /(?:(?:^|\s)[%$#❯➜]|[~\]:][$#])\s*$/u, // `max@mac repo % `, `❯ `, `~$ `
    /^➜\s/u, // `➜  repo git:(main) ✗`
    /^(?:\S+@\S+[: ].*[$#>]|[^\s:]+:\S* \S+[$#]|(?:ba|z)?sh-[\d.]+[$#])\s*$/u // `user@host:~/repo$`, `host:repo user$`, `bash-5.2$`, fish
];

const filled = text => String(text ?? '').replace(ANSI, '').split('\n').filter(line => line.trim());

/** The closing rule of Claude Code's input box (rule, `❯`, rule, at most a few status lines below), or null. */
function inputBox(lines) {
    for (let i = lines.length - 1; i > 0; i -= 1) {
        if (!INPUT.test(lines[i]) || MENU_OPTION.test(lines[i]) || !RULE.test(lines[i - 1])) continue;
        const close = lines.findIndex((line, k) => k > i && RULE.test(line));
        return close > i && lines.length - 1 - close <= 4 ? close : null;
    }
    return null;
}

/**
 * Does the capture end in Claude Code's own input box: a full-width rule, the `❯` prompt (a permission menu's
 * `❯ 1. Yes` does not count), a closing rule, and at most a few status lines below it? A shell prompt never has the
 * rules around it, so a pane back at zsh does not pass, whatever its prompt character.
 */
export const showsClaudeInput = text => inputBox(filled(text)) !== null;

/**
 * Does the capture end at a shell prompt? Under an input box only an unindented line counts: that is a prompt printed
 * after a killed Claude, while Claude's own status lines are indented and may end in a prompt character.
 */
export function showsShellPrompt(text) {
    const lines = filled(text);
    const close = inputBox(lines);
    const candidates = close === null ? lines.slice(-1) : lines.slice(close + 1).filter(line => /^\S/.test(line));
    return candidates.some(line => SHELL_PROMPTS.some(prompt => prompt.test(line)));
}

/** The question of an open question menu (Claude's AskUserQuestion and the like); null when none is showing. */
export function questionMenu(text) {
    const lines = filled(text).map(line => line.trim());
    if (!lines.slice(-5).some(line => QUESTION_FOOTER.test(line))) return null;
    return lines.slice(-30).findLast(line => line.endsWith('?')) ?? '';
}

/** A permission prompt, folder-trust prompt or question menu: Enter would answer it. */
export const asksPerson = text => !!(parsePrompt(text) || parseCodexPrompt(text) || questionMenu(text) !== null);

/** The agent says it is still working: a live spinner line, or background agents it is waiting for. */
export function showsWorking(text) {
    const lines = filled(text);
    return lines.slice(-12).some(line => WORKING.test(line)) || BACKGROUND.test(lines.slice(-20).join('\n'));
}
