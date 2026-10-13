#!/bin/bash
# Fake agent whose state is driven by files: usage idle-worker.sh <ctrlfile>
# Reads one word per poll from <ctrlfile>: run -> `kelpi event start`, stop -> `kelpi event stop`, wait -> notification.
CTRL="$1"
last=""
printf 'idle worker ready\n'
while true; do
  cur=$(cat "$CTRL" 2>/dev/null)
  if [ -n "$cur" ] && [ "$cur" != "$last" ]; then
    last="$cur"
    case "$cur" in
      run)  kelpi event start --agent claude >/dev/null 2>&1; printf 'working...\n' ;;
      stop) kelpi event stop --agent claude >/dev/null 2>&1; printf 'finished\n' ;;
      wait) kelpi event notification --agent claude --title "Waiting" --body "Waiting for input" >/dev/null 2>&1; printf 'waiting\n' ;;
      exit) exit 0 ;;
    esac
  fi
  sleep 0.5
done
