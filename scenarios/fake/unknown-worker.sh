#!/bin/bash
# Fake agent whose prompt has NO recognised header, so the plugin must treat it as a non-approvable Request.
# usage: unknown-worker.sh
printf 'worker starting\n'
kelpi event start --agent claude >/dev/null 2>&1
printf '\n Something new from Claude\n\n Do you want to continue?\n ❯ 1. Yes\n   2. No\n'
kelpi event notification --agent claude --title "Needs permission" --body "Needs permission for something new" >/dev/null 2>&1
sleep 600
