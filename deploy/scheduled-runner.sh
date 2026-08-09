#!/bin/sh

# Private one-shot runner used by the shared-host PHP gateway. The web request
# exits before Node starts, avoiding overlap with Hostinger's PHP worker memory.

set -u
umask 077

task=${1:-}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(dirname -- "$script_dir")
account_dir=$(dirname -- "$repo_dir")
node_bin="$account_dir/.nvm/versions/node/v22.22.0/bin/node"
lock_file="$repo_dir/.scheduler-$task.lock"
status_file="$repo_dir/.scheduler-$task.status"

case "$task" in
  consensus)
    delay_seconds=2
    ;;
  edge)
    # Stagger Edge away from the longer Consensus scan to protect the site and
    # the shared account's memory allowance.
    delay_seconds=28
    ;;
  *)
    exit 64
    ;;
esac

sleep "$delay_seconds"

write_status() {
  runner_state=$1
  runner_time=$2
  runner_code=$3
  runner_duration=$4
  status_tmp="$status_file.tmp.$$"
  printf '%s %s %s %s\n' "$runner_state" "$runner_time" "$runner_code" "$runner_duration" > "$status_tmp"
  chmod 600 "$status_tmp"
  mv -f "$status_tmp" "$status_file"
}

exec 9>"$lock_file"
if ! /usr/bin/flock -n 9; then
  exit 0
fi

# Never run two Node scanners together on the shared account. A rare delayed
# scan is safer than competing with the staging site for memory.
exec 8>"$repo_dir/.scheduler-node.lock"
if ! /usr/bin/flock -n 8; then
  write_status skipped "$(date +%s)" 0 0
  exit 0
fi

started_at=$(date +%s)
write_status running "$started_at" 0 0

if [ ! -x "$node_bin" ]; then
  write_status failed "$(date +%s)" 69 0
  exit 69
fi

set +e
case "$task" in
  consensus)
    /usr/bin/timeout -k 5s 52s "$node_bin" --max-old-space-size=96 "$repo_dir/bot.js" --scheduled-run >/dev/null 2>&1
    ;;
  edge)
    /usr/bin/timeout -k 5s 25s "$node_bin" --max-old-space-size=96 "$repo_dir/edge-bot/edge-bot.js" scheduled-run >/dev/null 2>&1
    ;;
esac
runner_code=$?
set -e

finished_at=$(date +%s)
duration_seconds=$((finished_at - started_at))
if [ "$runner_code" -eq 0 ]; then
  write_status ok "$finished_at" 0 "$duration_seconds"
else
  write_status failed "$finished_at" "$runner_code" "$duration_seconds"
fi
exit "$runner_code"
