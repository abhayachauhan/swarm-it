# Shared by swarm-spawn, swarm-send and swarm-wait. Source it; it runs nothing.

# jq: a news line's `at` as a string that sorts by time, whatever its number of fraction digits.
# Gives nothing for anything that is not a UTC ISO time.
NEWS_KEY='def key: strings | capture("^(?<s>[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})([.](?<f>[0-9]+))?Z$") | .s + "." + (((.f // "") + "000000000")[0:9]);'

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
