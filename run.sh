#!/usr/bin/env bash
# Keep a QUEST process running: restart it after a crash, an out-of-memory
# kill or its own memory brake, so one bad night doesn't leave it stopped for
# days.
#
# Ctrl-C (or kill -INT / -TERM on node) stops it for good: the scripts exit
# 130 when stopped on purpose, and that is the one exit this loop respects.
#
#   ./run.sh                  the crawler (quest.js), with quest.js's arguments
#   ./run.sh feeds.js         the xWire feed reader
#   QUEST_PAGES_PER_MINUTE=30 ./run.sh
#
# QUEST_CONTACT must be set (see README): without it the scripts refuse to
# start, and restarting them every minute would not change that.

cd "$(dirname "$0")" || exit 1

if [ -z "$QUEST_CONTACT" ]; then
  echo "[run.sh] QUEST_CONTACT is not set: give a web page or email address where site owners can reach you." >&2
  exit 1
fi

SCRIPT=quest.js
case "$1" in
  *.js) SCRIPT=$1; shift ;;
esac

RESTART_DELAY=60

while true; do
  node "$SCRIPT" "$@"
  code=$?
  if [ "$code" -eq 130 ]; then
    echo "[run.sh] $SCRIPT was stopped on purpose; not restarting."
    exit 0
  fi
  echo "[run.sh] $SCRIPT exited with code $code at $(date '+%F %T'); restarting in ${RESTART_DELAY}s (Ctrl-C to cancel)."
  sleep "$RESTART_DELAY" || exit 0
done
