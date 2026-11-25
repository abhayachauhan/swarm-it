# Shared by swarm-spawn, swarm-send and swarm-wait. Source it; it runs nothing.

# jq: a news line's `at` as a string that sorts by time, whatever its number of fraction digits.
# Gives nothing for anything that is not a UTC ISO time.
NEWS_KEY='def key: strings | capture("^(?<s>[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})([.](?<f>[0-9]+))?Z$") | .s + "." + (((.f // "") + "000000000")[0:9]);'

# mark <file> <text>: replace a marker file. rm then noclobber: never write through a symlink left at this path.
mark() { rm -f -- "$1"; ( set -C; echo "$2" >"$1" ) 2>/dev/null || true; }

# new_news <pane> <label> <news-dir>: print the lines whose `at` is later than the one in <pane>.seen, then
# save the latest there. Times, not byte offsets: the writer may drop old lines. A .seen that is not a time
# counts as empty; a line that is not a JSON object with a time is skipped. Returns 1 when there is nothing.
new_news() {
  local pane=$1 label=$2 f="$3/$1.jsonl" seen="$3/$1.seen" out
  [ -s "$f" ] || return 1
  # First output line is the latest `at`, the rest are the events.
  out=$(jq -rRn --arg w "$pane:$label" --arg seen "$(cat "$seen" 2>/dev/null || true)" "$NEWS_KEY"'
    def plain: tostring | gsub("[[:cntrl:]]"; " ") | .[0:200];
    (first($seen | key) // "") as $after
    | [inputs | fromjson? | objects | . as $line | .at | key | select(. > $after) | {k: ., line: $line}]
    | select(length > 0)
    | max_by(.k).line.at, (.[].line | "NEWS \($w) \(.kind // "unknown" | plain): \(.text // "" | plain)")' "$f" 2>/dev/null)
  [ -n "$out" ] || return 1
  # Print before saving: a caller killed in between repeats a line and never loses one.
  echo "${out#*$'\n'}"
  mark "$seen" "${out%%$'\n'*}"
}

# worker_instructions: sets FORMAT and HEARTBEAT, so a first task and a follow-up give a worker the same
# instructions. Needs RES (the results directory) and label.
worker_instructions() {
  FORMAT="Write the result as markdown with three headings, ## Goal, ## Done and ## Next. Goal is one plain sentence saying what you were asked to do. Done is at most three short bullets saying what is now true or what you found, in plain words, with no code, file dumps or tool narration. Next is at most two bullets of what a human must decide or do, or the words Nothing pending. Keep the whole file under 80 words."
  # Both agents get this one. The status file is the sign of life between results.
  HEARTBEAT="Keep a heartbeat in $RES/$label.status: append one line per state change with one shell command, echo \"\$(date -u +%Y-%m-%dT%H:%M:%SZ) working: <short what>\" >> $RES/$label.status. The text after the time is started, working: <short what>, pr-open: #123 <sha>, blocked: <why> or done. Write at most one line every few minutes, but a working: line at least every 15 minutes during long work. Append, never overwrite. Each time you finish a task, write the final done line last, after the result file."
}

# write_prompt <text>: saves the prompt to its own file under ~/.kelpi-swarm/prompts and sets promptFile.
# One file per message, so two that share a label cannot swap prompts before they are read.
write_prompt() {
  local prompts="$HOME/.kelpi-swarm/prompts"
  mkdir -p "$prompts"
  find "$prompts" -name '*.txt' -mtime +1 -delete 2>/dev/null || true
  promptFile=$(mktemp "$prompts/$label.XXXXXX") || return 1
  mv "$promptFile" "$promptFile.txt" && promptFile=$promptFile.txt
  printf '%s\n' "$1" >"$promptFile"
}

# archive_result: moves results/<label>.md to results/archive/ so the next result is detectably new.
archive_result() {
  mkdir -p "$RES/archive"
  [ -e "$RES/$label.md" ] || return 0
  local to
  to="$RES/archive/$label.$(date -u +%Y%m%dT%H%M%SZ).md"
  # A second archive in the same second must not overwrite the first.
  [ ! -e "$to" ] || to="${to%.md}.$$.md"
  mv -n "$RES/$label.md" "$to"
  [ ! -e "$RES/$label.md" ]
}
