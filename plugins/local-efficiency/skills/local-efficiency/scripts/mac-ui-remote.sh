#!/bin/bash
# Remote half of host-run's mac-ui forwarding. The workstation sends this
# script over ssh on every call (`bash -c SCRIPT host-run-remote SUBCOMMAND
# ...`), so the protocol never depends on the receiving host's installed
# version. Everything it creates lives under
# ~/.local/state/host-run/remote/<id>; it never writes to an existing
# checkout's working tree, index or refs.
#
# Subcommands:
#   list                           print "kind<TAB>path<TAB>origin" for ~/src/*
#   have REPO SHA...               print the SHAs whose commits REPO has
#   run ID REPO SHA PREFIX LAUNCHER KEEP DEADLINE_S HOST_RUN -- HOST_RUN_ARGS...
#                                  read a tar (bundle, patch) on stdin, build a
#                                  throwaway tree and run HOST_RUN in the GUI
#                                  session; exits with the command's status
#   cancel ID                      ask a running job to stop (TERM)
#   fetch ID PATH...               write a tar of PATH... from the tree
#   cleanup ID                     unload the job and remove the run directory
#
# When the host's ~/.config/host-run/mac-ui.json names a HostRun UI.app
# helper (`host-run mac-ui install-helper` writes it), the launchd job runs
# through that app so macOS privacy grants apply to it rather than to
# /bin/bash. A configured helper that is missing or broken stops the run with
# exit 69; it never falls back to /bin/bash.
set -u

state_root="$HOME/.local/state/host-run/remote"
uid=$(id -u)
host=$(hostname -s 2>/dev/null || echo remote)
unavailable=69

die() {
  printf '[host-run remote %s] %s\n' "$host" "$*" >&2
  exit "$unavailable"
}

valid_id() {
  case "$1" in
    "" | *[!A-Za-z0-9-]*) die "invalid run id" ;;
  esac
}

job_label() { printf 'dev.hraness.host-run.mac-ui.%s' "$1"; }

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

job_loaded() { launchctl print "gui/$uid/$(job_label "$1")" >/dev/null 2>&1; }

# Removes run directories older than a day whose job is no longer loaded:
# leftovers from a workstation that lost its connection before cleanup.
sweep_stale() {
  [ -d "$state_root" ] || return 0
  for old in "$state_root"/*; do
    [ -d "$old" ] || continue
    name=${old##*/}
    case "$name" in "" | *[!A-Za-z0-9-]*) continue ;; esac
    [ -n "$(find "$old" -maxdepth 0 -mtime +0 2>/dev/null)" ] || continue
    job_loaded "$name" && continue
    rm -rf "$old"
  done
}

sub=${1:-}
[ $# -gt 0 ] && shift

case "$sub" in
list)
  for candidate in "$HOME"/src/*; do
    [ -e "$candidate/.git" ] || continue
    url=$(git -C "$candidate" remote get-url origin 2>/dev/null) || continue
    kind=file
    [ -d "$candidate/.git" ] && kind=dir
    printf '%s\t%s\t%s\n' "$kind" "$candidate" "$url"
  done
  exit 0
  ;;

have)
  repo=$1
  shift
  [ -e "$repo/.git" ] || die "no repository at $repo"
  for sha in "$@"; do
    if git -C "$repo" cat-file -e "$sha^{commit}" 2>/dev/null; then printf '%s\n' "$sha"; fi
  done
  exit 0
  ;;

cancel)
  id=$1
  valid_id "$id"
  dir="$state_root/$id"
  [ -d "$dir" ] && : >"$dir/cancel"
  launchctl kill SIGTERM "gui/$uid/$(job_label "$id")" >/dev/null 2>&1
  if [ -f "$dir/job.pid" ]; then kill -TERM "$(cat "$dir/job.pid")" 2>/dev/null; fi
  exit 0
  ;;

fetch)
  id=$1
  shift
  valid_id "$id"
  tree="$state_root/$id/tree"
  [ -d "$tree" ] || die "run $id has no tree to copy artifacts from"
  cd "$tree" || die "cannot enter $tree"
  found=()
  for path in "$@"; do
    if [ -e "$path" ] || [ -L "$path" ]; then
      found+=("$path")
    else
      printf '[host-run remote %s] artifact not found: %s\n' "$host" "$path" >&2
    fi
  done
  [ ${#found[@]} -gt 0 ] || exit 3
  exec tar -cf - -- "${found[@]}"
  ;;

cleanup)
  id=$1
  valid_id "$id"
  launchctl bootout "gui/$uid/$(job_label "$id")" >/dev/null 2>&1
  rm -rf "$state_root/$id"
  exit 0
  ;;

run) ;;

*)
  die "unknown subcommand: $sub"
  ;;
esac

# ---- run ----
[ $# -ge 9 ] || die "run needs ID REPO SHA PREFIX LAUNCHER KEEP DEADLINE HOST_RUN -- ARGS"
id=$1 repo=$2 sha=$3 prefix=$4 launcher=$5 keep=$6 deadline_s=$7 host_run=$8
shift 8
[ "${1:-}" = "--" ] || die "run arguments must end with --"
shift
valid_id "$id"
case "$launcher" in launchd | direct) ;; *) die "invalid launcher: $launcher" ;; esac
case "$sha" in "" | *[!0-9a-f]*) die "invalid commit: $sha" ;; esac
case "$deadline_s" in "" | *[!0-9]*) die "invalid deadline: $deadline_s" ;; esac
[ -e "$repo/.git" ] || die "no repository at $repo"

# The helper app, when this host is configured for one. Checked before any
# state is created so a broken install fails fast.
helper=""
helper_config=${XDG_CONFIG_HOME:-$HOME/.config}/host-run/mac-ui.json
if [ -e "$helper_config" ]; then
  helper_app=$(plutil -extract helper.app raw -o - "$helper_config" 2>/dev/null) \
    || die "$helper_config has no helper.app; run host-run mac-ui install-helper on $host"
  helper="$helper_app/Contents/MacOS/host-run-ui"
  [ -x "$helper" ] || die "HostRun UI is configured in $helper_config but $helper is missing; run host-run mac-ui install-helper on $host"
  codesign --verify --strict "$helper_app" >/dev/null 2>&1 \
    || die "HostRun UI at $helper_app does not pass codesign --verify; run host-run mac-ui install-helper on $host"
  codesign --display --verbose=2 "$helper_app" 2>&1 | grep -qx 'Identifier=com.hraness.host-run-ui' \
    || die "$helper_app is not signed as com.hraness.host-run-ui; run host-run mac-ui install-helper on $host"
fi

mkdir -p "$state_root" || die "cannot create $state_root"
chmod 700 "$state_root" "$HOME/.local/state/host-run" 2>/dev/null
sweep_stale
dir="$state_root/$id"
mkdir "$dir" || die "run directory $dir already exists"
chmod 700 "$dir"
label=$(job_label "$id")
started=0
cat_pids=()

cleanup_run() {
  if [ "$launcher" = launchd ] && [ "$started" = 1 ]; then
    launchctl bootout "gui/$uid/$label" >/dev/null 2>&1
  fi
  for pid in "${cat_pids[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null; done
  rm -rf "$dir"
}

prepare_failed() {
  cleanup_run
  die "$*"
}

# A dropped connection or a signal asks the job to stop; the wait loop below
# then collects its status and cleans up.
on_signal() {
  : >"$dir/cancel" 2>/dev/null
  if [ "$started" = 0 ]; then
    cleanup_run
    exit 143
  fi
}
trap on_signal HUP INT TERM
trap '' PIPE

mkdir "$dir/payload" || prepare_failed "cannot create payload directory"
tar -xf - -C "$dir/payload" || prepare_failed "could not read the forwarded payload"

git clone --quiet --shared --no-checkout "$repo" "$dir/tree" >/dev/null 2>&1 \
  || prepare_failed "could not create a throwaway clone of $repo"
origin=$(git -C "$repo" remote get-url origin 2>/dev/null)
[ -n "$origin" ] && git -C "$dir/tree" remote set-url origin "$origin"
if [ -s "$dir/payload/bundle" ]; then
  git -C "$dir/tree" bundle unbundle "$dir/payload/bundle" >/dev/null 2>"$dir/unbundle.err" \
    || prepare_failed "could not apply the commit bundle: $(tail -n 3 "$dir/unbundle.err")"
fi
git -C "$dir/tree" cat-file -e "$sha^{commit}" 2>/dev/null \
  || prepare_failed "commit $sha is not available on $host"
# Reuse the existing clone's Git LFS objects instead of downloading them again.
if [ -d "$repo/.git/lfs" ]; then git -C "$dir/tree" config lfs.storage "$repo/.git/lfs"; fi
git -C "$dir/tree" -c advice.detachedHead=false checkout --quiet --detach "$sha" 2>"$dir/checkout.err" \
  || prepare_failed "could not check out $sha: $(tail -n 3 "$dir/checkout.err")"
if [ -s "$dir/payload/patch" ]; then
  git -C "$dir/tree" apply --binary --whitespace=nowarn "$dir/payload/patch" 2>"$dir/apply.err" \
    || prepare_failed "could not apply the uncommitted changes: $(tail -n 3 "$dir/apply.err")"
fi
workdir="$dir/tree/$prefix"
[ -d "$workdir" ] || prepare_failed "working directory $prefix does not exist at $sha with the patch applied"
if [ -f "$dir/cancel" ]; then cleanup_run; exit 143; fi

{
  printf '#!/bin/bash\n'
  printf 'cd %q || { printf 1 >%q; exit 1; }\n' "$workdir" "$dir/exit"
  printf 'export PATH=%q\n' "$PATH"
  printf 'export LOCAL_EFFICIENCY_FORWARDED=1\n'
  printf '%q' "$host_run"
  for argument in "$@"; do printf ' %q' "$argument"; done
  printf ' </dev/null &\n'
  printf 'child=$!\n'
  printf 'trap '\''kill -TERM "$child" 2>/dev/null'\'' TERM INT HUP\n'
  printf 'while :; do\n'
  printf '  wait "$child"; rc=$?\n'
  printf '  if [ "$rc" -gt 128 ] && kill -0 "$child" 2>/dev/null; then continue; fi\n'
  printf '  break\n'
  printf 'done\n'
  printf 'printf "%%s\\n" "$rc" >%q && mv %q %q\n' "$dir/exit.tmp" "$dir/exit.tmp" "$dir/exit"
  printf 'exit "$rc"\n'
} >"$dir/job.sh" || prepare_failed "could not write the job script"
chmod 700 "$dir/job.sh"

if [ "$launcher" = launchd ]; then
  mkfifo "$dir/stdout" "$dir/stderr" || prepare_failed "could not create output pipes"
  cat "$dir/stdout" &
  cat_pids+=($!)
  cat "$dir/stderr" >&2 &
  cat_pids+=($!)
  if [ -n "$helper" ]; then
    token=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
    [ ${#token} -eq 48 ] || prepare_failed "could not create a one-time token"
    (umask 077 && printf '%s\n' "$token" >"$dir/helper-token") || prepare_failed "could not write the one-time token"
    program="<string>$(xml_escape "$helper")</string><string>run</string><string>$(xml_escape "$dir")</string><string>$token</string>"
  else
    program="<string>/bin/bash</string><string>$(xml_escape "$dir/job.sh")</string>"
  fi
  cat >"$dir/job.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$(xml_escape "$label")</string>
  <key>ProgramArguments</key>
  <array>$program</array>
  <key>StandardOutPath</key><string>$(xml_escape "$dir/stdout")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$dir/stderr")</string>
  <key>EnvironmentVariables</key>
  <dict><key>HOME</key><string>$(xml_escape "$HOME")</string></dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
PLIST
  launchctl bootstrap "gui/$uid" "$dir/job.plist" 2>"$dir/bootstrap.err" \
    || prepare_failed "could not start the job in the GUI session gui/$uid ($(tr '\n' ' ' <"$dir/bootstrap.err")); is $(id -un) logged in at the console?"
  started=1
else
  # Test-only launcher: runs the job as a plain child of this script.
  /bin/bash "$dir/job.sh" &
  printf '%s\n' "$!" >"$dir/job.pid"
  started=1
fi

job_running() {
  if [ "$launcher" = launchd ]; then
    launchctl print "gui/$uid/$label" 2>/dev/null | grep -q 'state = running'
  else
    kill -0 "$(cat "$dir/job.pid")" 2>/dev/null
  fi
}

stop_job() {
  if [ "$launcher" = launchd ]; then
    launchctl kill SIGTERM "gui/$uid/$label" >/dev/null 2>&1
  else
    kill -TERM "$(cat "$dir/job.pid")" 2>/dev/null
  fi
}

start_s=$(date +%s)
cancel_sent=0
cancel_at=0
idle_checks=0
ticks=0
while [ ! -f "$dir/exit" ]; do
  sleep 0.5
  ticks=$((ticks + 1))
  now_s=$(date +%s)
  if [ -f "$dir/cancel" ] && [ "$cancel_sent" = 0 ]; then
    stop_job
    cancel_sent=1
    cancel_at=$now_s
  fi
  if [ "$cancel_sent" = 0 ] && [ $((now_s - start_s)) -ge "$deadline_s" ]; then
    printf '[host-run remote %s] run exceeded its %ss forwarding deadline; stopping it\n' "$host" "$deadline_s" >&2
    : >"$dir/cancel"
    continue
  fi
  if [ "$cancel_sent" = 1 ] && [ $((now_s - cancel_at)) -ge 60 ]; then
    printf '[host-run remote %s] job did not stop within 60s of TERM; unloading it\n' "$host" >&2
    break
  fi
  # launchctl print is not free; check liveness every 2 s.
  if [ $((ticks % 4)) -eq 0 ]; then
    if job_running; then
      idle_checks=0
    else
      idle_checks=$((idle_checks + 1))
      [ "$idle_checks" -ge 3 ] && break
    fi
  fi
done

if [ -f "$dir/exit" ]; then
  rc=$(tr -dc '0-9' <"$dir/exit")
  [ -n "$rc" ] || rc=1
elif [ -n "$helper" ] && [ "$launcher" = launchd ] && [ -e "$dir/helper-token" ]; then
  printf '[host-run remote %s] HostRun UI did not start the job\n' "$host" >&2
  rc=$unavailable
else
  printf '[host-run remote %s] job ended without reporting a status\n' "$host" >&2
  rc=1
fi

# Let the output pipes drain, bounded at 10 s.
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  alive=0
  for pid in "${cat_pids[@]:-}"; do [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && alive=1; done
  [ "$alive" = 0 ] && break
  sleep 0.5
done
if [ "$launcher" = launchd ]; then launchctl bootout "gui/$uid/$label" >/dev/null 2>&1; fi
for pid in "${cat_pids[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null; done
cat_pids=()
started=0
if [ "$keep" != 1 ]; then rm -rf "$dir"; fi
exit "$rc"
