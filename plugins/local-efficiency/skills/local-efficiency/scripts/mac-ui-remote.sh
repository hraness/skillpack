#!/bin/bash
# Remote half of host-run's forwarding (the mac-ui lane and heavy compute).
# The workstation sends this script over ssh on every call (`bash -c SCRIPT
# host-run-remote SUBCOMMAND ...`), so the protocol never depends on the
# receiving host's installed version. Everything it creates lives under
# ~/.local/state/host-run; it never writes to a checkout under ~/src.
#
# Subcommands:
#   list                           print "kind<TAB>path<TAB>origin" for ~/src/*
#                                  and for repositories seeded into host-run state
#   have REPO SHA...               print the SHAs whose commits REPO has
#   seed KEY ORIGIN                read a full git bundle on stdin and keep it as
#                                  a bare repository under state/seed/KEY
#   run ID REPO SHA PREFIX LAUNCHER KEEP DEADLINE_S HOST_RUN -- HOST_RUN_ARGS...
#                                  read a tar (bundle, patch) on stdin, build a
#                                  throwaway tree and run HOST_RUN in the GUI
#                                  session; exits with the command's status
#   compute ID REPO SHA PREFIX KEY SLOTS CACHE_GIB MIN_FREE_GIB DEADLINE_S HOST_RUN -- HOST_RUN_ARGS...
#                                  same payload, but reset a cached per-repository
#                                  workspace (build output kept) and run HOST_RUN
#                                  as a plain background process at lower priority
#   cancel ID                      ask a running job to stop (TERM)
#   fetch ID PATH...               write a tar of PATH... from the tree
#   cleanup ID [versions]          report whether the command started, then
#                                  unload the job and remove the run directory
#
# When the host's ~/.config/host-run/mac-ui.json names a HostRun UI.app
# helper (`host-run mac-ui install-helper` writes it), the launchd job runs
# through that app so macOS privacy grants apply to it rather than to
# /bin/bash. A configured helper that is missing or broken stops the run with
# exit 69; it never falls back to /bin/bash.
set -u

host_state="$HOME/.local/state/host-run"
state_root="$host_state/remote"
seed_root="$host_state/seed"
compute_root="$host_state/compute"
uid=$(id -u)
host=$(hostname -s 2>/dev/null || echo remote)
unavailable=69
reason_file=""

die() {
  printf '[host-run remote %s] %s\n' "$host" "$*" >&2
  [ -n "$reason_file" ] && printf '%s\n' "$*" >"$reason_file" 2>/dev/null
  exit "$unavailable"
}

say() { printf '[host-run remote %s] %s\n' "$host" "$*" >&2; }

valid_id() {
  case "$1" in
    "" | *[!A-Za-z0-9-]*) die "invalid run id" ;;
  esac
}

valid_key() {
  case "$1" in
    "" | .* | *[!A-Za-z0-9._-]*) die "invalid repository key" ;;
  esac
}

valid_count() {
  case "$1" in
    "" | *[!0-9]*) die "invalid $2: $1" ;;
  esac
}

# A checkout (`.git` file or directory) or a bare repository.
is_repo() { [ -e "$1/.git" ] || { [ -f "$1/HEAD" ] && [ -d "$1/objects" ]; }; }

is_seed() {
  case "$1" in "$seed_root"/*) return 0 ;; esac
  return 1
}

free_gib() { df -k "$HOME" 2>/dev/null | awk 'NR == 2 { print int($4 / 1048576) }'; }

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
  for candidate in "$seed_root"/*; do
    [ -f "$candidate/HEAD" ] || continue
    url=$(git -C "$candidate" config --get remote.origin.url 2>/dev/null) || continue
    printf 'seed\t%s\t%s\n' "$candidate" "$url"
  done
  exit 0
  ;;

have)
  repo=$1
  shift
  is_repo "$repo" || die "no repository at $repo"
  for sha in "$@"; do
    if git -C "$repo" cat-file -e "$sha^{commit}" 2>/dev/null; then printf '%s\n' "$sha"; fi
  done
  exit 0
  ;;

seed)
  [ $# -eq 2 ] || die "seed needs KEY ORIGIN"
  key=$1 origin=$2
  valid_key "$key"
  case "$origin" in "" | -* | *[[:cntrl:]]*) die "invalid origin" ;; esac
  target="$seed_root/$key"
  if [ -f "$target/HEAD" ]; then
    cat >/dev/null
    printf 'exists\n'
    exit 0
  fi
  free=$(free_gib)
  [ "${free:-0}" -ge 20 ] || die "only ${free:-0} GiB free on $host; not seeding a new repository"
  mkdir -p "$seed_root" || die "cannot create $seed_root"
  chmod 700 "$host_state" "$seed_root" 2>/dev/null
  # Incoming directories older than a day are left by an interrupted seed.
  find "$seed_root" -maxdepth 1 -name '.incoming-*' -mtime +0 -exec rm -rf {} + 2>/dev/null
  incoming="$seed_root/.incoming-$key-$$"
  rm -rf "$incoming"
  mkdir "$incoming" || die "cannot create $incoming"
  trap 'rm -rf "$incoming"' EXIT
  cat >"$incoming/seed.bundle" || die "could not read the seed bundle"
  git init --quiet --bare "$incoming/repo" >/dev/null 2>&1 || die "could not create a bare repository"
  git -C "$incoming/repo" fetch --quiet "$incoming/seed.bundle" '+refs/*:refs/*' 2>"$incoming/fetch.err" \
    || die "could not read the seed bundle: $(tail -n 3 "$incoming/fetch.err")"
  head=$(git bundle list-heads "$incoming/seed.bundle" HEAD 2>/dev/null | awk 'NR == 1 { print $1 }')
  [ -n "$head" ] && git -C "$incoming/repo" update-ref refs/host-run/last "$head"
  git -C "$incoming/repo" config remote.origin.url "$origin"
  mv "$incoming/repo" "$target" 2>/dev/null || {
    [ -f "$target/HEAD" ] && { printf 'exists\n'; exit 0; }
    die "could not move the seeded repository into $target"
  }
  printf 'seeded\n'
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
  dir="$state_root/$id"
  if [ -f "$dir/started" ]; then
    printf 'state\tstarted\n'
  elif [ -d "$dir" ]; then
    printf 'state\tnot-started\n'
    [ -f "$dir/reason" ] && printf 'reason\t%s\n' "$(head -c 600 "$dir/reason" | tr '\n\t' '  ')"
  else
    printf 'state\tgone\n'
  fi
  if [ "${2:-}" = versions ]; then
    printf 'macos\t%s\n' "$(sw_vers -productVersion 2>/dev/null)"
    printf 'xcode\t%s\n' "$(xcodebuild -version 2>/dev/null | head -n 1)"
  fi
  launchctl bootout "gui/$uid/$(job_label "$id")" >/dev/null 2>&1
  rm -rf "$dir"
  exit 0
  ;;

run | compute) ;;

*)
  die "unknown subcommand: $sub"
  ;;
esac

# ---- run / compute ----
if [ "$sub" = run ]; then
  [ $# -ge 9 ] || die "run needs ID REPO SHA PREFIX LAUNCHER KEEP DEADLINE HOST_RUN -- ARGS"
  id=$1 repo=$2 sha=$3 prefix=$4 launcher=$5 keep=$6 deadline_s=$7 host_run=$8
  shift 8
  case "$launcher" in launchd | direct) ;; *) die "invalid launcher: $launcher" ;; esac
else
  [ $# -ge 11 ] || die "compute needs ID REPO SHA PREFIX KEY SLOTS CACHE_GIB MIN_FREE_GIB DEADLINE HOST_RUN -- ARGS"
  id=$1 repo=$2 sha=$3 prefix=$4 key=$5 slots=$6 cache_gib=$7 min_free_gib=$8 deadline_s=$9 host_run=${10}
  shift 10
  valid_key "$key"
  valid_count "$slots" "workspace count"
  valid_count "$cache_gib" "cache size"
  valid_count "$min_free_gib" "free space floor"
  [ "$slots" -ge 1 ] || die "invalid workspace count: $slots"
  # A plain child of this ssh session: no GUI session, no launchd job. The
  # run directory stays until cleanup so the workstation can ask whether the
  # command started.
  launcher=direct
  keep=1
fi
[ "${1:-}" = "--" ] || die "$sub arguments must end with --"
shift
valid_id "$id"
case "$sha" in "" | *[!0-9a-f]*) die "invalid commit: $sha" ;; esac
case "$deadline_s" in "" | *[!0-9]*) die "invalid deadline: $deadline_s" ;; esac
is_repo "$repo" || die "no repository at $repo"

# The helper app, when this host is configured for one. Checked before any
# state is created so a broken install fails fast.
helper=""
helper_config=${XDG_CONFIG_HOME:-$HOME/.config}/host-run/mac-ui.json
if [ "$sub" = run ] && [ -e "$helper_config" ]; then
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
chmod 700 "$state_root" "$host_state" 2>/dev/null
sweep_stale
dir="$state_root/$id"
mkdir "$dir" || die "run directory $dir already exists"
chmod 700 "$dir"
[ "$sub" = compute ] && reason_file="$dir/reason"
label=$(job_label "$id")
started=0
cat_pids=()
slot_lock=""
slot_dir=""
start_s=$(date +%s)

release_slot() {
  [ -n "$slot_lock" ] && rm -rf "$slot_lock"
  slot_lock=""
}

cleanup_run() {
  if [ "$launcher" = launchd ] && [ "$started" = 1 ]; then
    launchctl bootout "gui/$uid/$label" >/dev/null 2>&1
  fi
  for pid in "${cat_pids[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null; done
  release_slot
  if [ "$keep" != 1 ]; then rm -rf "$dir"; fi
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
trap release_slot EXIT

mkdir "$dir/payload" || prepare_failed "cannot create payload directory"
tar -xf - -C "$dir/payload" || prepare_failed "could not read the forwarded payload"

# A seeded repository belongs to host-run, so keep it current: later runs
# then send only the commits made since this one.
if is_seed "$repo" && [ -s "$dir/payload/bundle" ]; then
  git -C "$repo" fetch --quiet "$dir/payload/bundle" "+HEAD:refs/host-run/last" >/dev/null 2>&1
fi

lock_alive() {
  local lock=$1 pid
  for pid in $(cat "$lock/pid" "$lock/job" 2>/dev/null); do
    kill -0 "$pid" 2>/dev/null && return 0
  done
  return 1
}

# Keeps the cached workspaces within CACHE_GIB in total and the disk above
# MIN_FREE_GIB by moving the least recently used idle workspaces aside. Runs
# under the claim lock; the moved trees are deleted after it is released.
trash=()
evict_caches() {
  local free total_kb size_file size_kb victim used candidate
  free=$(free_gib)
  free=${free:-0}
  total_kb=0
  for size_file in "$compute_root"/*/slot-*/size; do
    [ -f "$size_file" ] || continue
    size_kb=$(tr -dc '0-9' <"$size_file")
    total_kb=$((total_kb + ${size_kb:-0}))
  done
  while [ "$free" -lt "$min_free_gib" ] || [ $((total_kb / 1048576)) -gt "$cache_gib" ]; do
    victim=""
    for used in $(ls -tr "$compute_root"/*/slot-*/last-used 2>/dev/null); do
      candidate=${used%/last-used}
      [ "$candidate" = "$slot_dir" ] && continue
      lock_alive "$candidate.lock" && continue
      victim=$candidate
      break
    done
    [ -n "$victim" ] || break
    size_kb=$(tr -dc '0-9' <"$victim/size" 2>/dev/null)
    size_kb=${size_kb:-0}
    mkdir -p "$compute_root/.trash"
    mv "$victim" "$compute_root/.trash/$id-${#trash[@]}" || break
    trash+=("$compute_root/.trash/$id-${#trash[@]}")
    rm -rf "$victim.lock"
    total_kb=$((total_kb - size_kb))
    free=$((free + size_kb / 1048576))
    say "evicted the cached workspace ${victim#"$compute_root"/} ($((size_kb / 1048576)) GiB) to stay within ${cache_gib} GiB of caches and ${min_free_gib} GiB free"
  done
}

# Claims one of SLOTS workspaces for this repository, waiting while all are
# in use. The claim lock is a directory; one left by a killed run is
# removed after two minutes.
claim_slot() {
  local ws=$compute_root/$key waited=0 n lock
  mkdir -p "$ws" || prepare_failed "cannot create $ws"
  chmod 700 "$compute_root" 2>/dev/null
  while :; do
    if mkdir "$compute_root/.claim" 2>/dev/null; then
      for n in $(seq 1 "$slots"); do
        lock="$ws/slot-$n.lock"
        if [ -d "$lock" ]; then
          lock_alive "$lock" && continue
          rm -rf "$lock"
        fi
        if mkdir "$lock" 2>/dev/null; then
          printf '%s\n' "$$" >"$lock/pid"
          printf '%s\n' "$id" >"$lock/run"
          slot_lock=$lock
          slot_dir="$ws/slot-$n"
          break
        fi
      done
      [ -n "$slot_lock" ] && evict_caches
      rmdir "$compute_root/.claim"
      if [ -n "$slot_lock" ]; then
        [ ${#trash[@]} -gt 0 ] && (rm -rf "${trash[@]}" </dev/null >/dev/null 2>&1 &)
        return 0
      fi
    elif [ -n "$(find "$compute_root/.claim" -maxdepth 0 -mmin +2 2>/dev/null)" ]; then
      rmdir "$compute_root/.claim" 2>/dev/null
    fi
    if [ "$waited" = 0 ]; then
      say "all $slots cached workspaces for $key are in use; waiting for one"
      waited=1
    fi
    [ -f "$dir/cancel" ] && { cleanup_run; exit 143; }
    [ $(($(date +%s) - start_s)) -lt "$deadline_s" ] || prepare_failed "no cached workspace for $key became free within ${deadline_s}s"
    sleep 2
  done
}

# Resets the claimed workspace to SHA plus the patch. Ignored files (build
# output such as target/, .build/, node_modules/) stay as the cache;
# tracked changes and untracked files from earlier runs are removed.
prepare_failure=""
reset_workspace() {
  local tree=$1
  if [ ! -e "$tree/.git" ]; then
    rm -rf "$tree"
    git clone --quiet --shared --no-checkout "$repo" "$tree" >/dev/null 2>"$dir/clone.err" \
      || { prepare_failure="could not create a workspace clone of $repo: $(tail -n 3 "$dir/clone.err")"; return 1; }
    say "created the cached workspace ${tree#"$compute_root"/} (cold: no build cache yet)"
  fi
  local origin
  origin=$(git -C "$repo" config --get remote.origin.url 2>/dev/null)
  [ -n "$origin" ] && git -C "$tree" remote set-url origin "$origin" 2>/dev/null
  if [ -s "$dir/payload/bundle" ]; then
    git -C "$tree" bundle unbundle "$dir/payload/bundle" >/dev/null 2>"$dir/unbundle.err" \
      || { prepare_failure="could not apply the commit bundle: $(tail -n 3 "$dir/unbundle.err")"; return 1; }
  fi
  git -C "$tree" cat-file -e "$sha^{commit}" 2>/dev/null \
    || { prepare_failure="commit $sha is not available on $host"; return 1; }
  if [ -d "$repo/.git/lfs" ]; then git -C "$tree" config lfs.storage "$repo/.git/lfs"; fi
  git -C "$tree" -c advice.detachedHead=false checkout --quiet --force --detach "$sha" 2>"$dir/checkout.err" \
    || { prepare_failure="could not check out $sha: $(tail -n 3 "$dir/checkout.err")"; return 1; }
  git -C "$tree" clean -ffdq 2>"$dir/clean.err" \
    || { prepare_failure="could not clean the workspace: $(tail -n 3 "$dir/clean.err")"; return 1; }
  if [ -f "$tree/.gitmodules" ]; then
    git -C "$tree" submodule update --init --recursive --quiet 2>"$dir/submodule.err" \
      || { prepare_failure="could not check out submodules: $(tail -n 3 "$dir/submodule.err")"; return 1; }
  fi
  return 0
}

if [ "$sub" = compute ]; then
  claim_slot
  tree="$slot_dir/tree"
  if ! reset_workspace "$tree"; then
    # A damaged workspace is rebuilt once from scratch before giving up.
    say "$prepare_failure; rebuilding the workspace"
    rm -rf "$tree"
    reset_workspace "$tree" || prepare_failed "$prepare_failure"
  fi
else
  tree="$dir/tree"
  git clone --quiet --shared --no-checkout "$repo" "$tree" >/dev/null 2>&1 \
    || prepare_failed "could not create a throwaway clone of $repo"
  origin=$(git -C "$repo" config --get remote.origin.url 2>/dev/null)
  [ -n "$origin" ] && git -C "$tree" remote set-url origin "$origin"
  if [ -s "$dir/payload/bundle" ]; then
    git -C "$tree" bundle unbundle "$dir/payload/bundle" >/dev/null 2>"$dir/unbundle.err" \
      || prepare_failed "could not apply the commit bundle: $(tail -n 3 "$dir/unbundle.err")"
  fi
  git -C "$tree" cat-file -e "$sha^{commit}" 2>/dev/null \
    || prepare_failed "commit $sha is not available on $host"
  # Reuse the existing clone's Git LFS objects instead of downloading them again.
  if [ -d "$repo/.git/lfs" ]; then git -C "$tree" config lfs.storage "$repo/.git/lfs"; fi
  git -C "$tree" -c advice.detachedHead=false checkout --quiet --detach "$sha" 2>"$dir/checkout.err" \
    || prepare_failed "could not check out $sha: $(tail -n 3 "$dir/checkout.err")"
fi
if [ -s "$dir/payload/patch" ]; then
  git -C "$tree" apply --binary --whitespace=nowarn "$dir/payload/patch" 2>"$dir/apply.err" \
    || prepare_failed "could not apply the uncommitted changes: $(tail -n 3 "$dir/apply.err")"
fi
workdir="$tree/$prefix"
[ -d "$workdir" ] || prepare_failed "working directory $prefix does not exist at $sha with the patch applied"
if [ -f "$dir/cancel" ]; then cleanup_run; exit 143; fi

# Compute runs at nice 10: CI runners and the host's own interactive work
# win CPU contention, while the build still uses performance cores
# (`taskpolicy -b` would confine it to efficiency cores and throttle I/O).
priority=""
[ "$sub" = compute ] && priority="nice -n 10 "
{
  printf '#!/bin/bash\n'
  printf 'cd %q || { printf 1 >%q; exit 1; }\n' "$workdir" "$dir/exit"
  printf 'export PATH=%q\n' "$PATH"
  printf 'export LOCAL_EFFICIENCY_FORWARDED=1\n'
  printf ': >%q\n' "$dir/started"
  printf '%s%q' "$priority" "$host_run"
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
  # A plain child of this script: compute runs, and mac-ui tests.
  /bin/bash "$dir/job.sh" &
  printf '%s\n' "$!" >"$dir/job.pid"
  [ -n "$slot_lock" ] && printf '%s\n' "$!" >"$slot_lock/job"
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

# sshd ends the session when the workstation disconnects, and this script is
# then reparented to launchd (pid 1).
connection_lost() { [ "$(ps -o ppid= -p $$ 2>/dev/null | tr -d ' ')" = 1 ]; }

run_start_s=$(date +%s)
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
  if [ "$cancel_sent" = 0 ] && [ $((now_s - run_start_s)) -ge "$deadline_s" ]; then
    say "run exceeded its ${deadline_s}s forwarding deadline; stopping it"
    : >"$dir/cancel"
    continue
  fi
  if [ "$cancel_sent" = 1 ] && [ $((now_s - cancel_at)) -ge 60 ]; then
    say "job did not stop within 60s of TERM; unloading it"
    break
  fi
  # launchctl print is not free; check liveness every 2 s.
  if [ $((ticks % 4)) -eq 0 ]; then
    if [ "$cancel_sent" = 0 ] && connection_lost; then
      : >"$dir/cancel"
      continue
    fi
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
  say "HostRun UI did not start the job"
  rc=$unavailable
else
  say "job ended without reporting a status"
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
if [ -n "$slot_dir" ]; then
  # Record use and (in the background, after the lock is released) the
  # workspace size that eviction budgets against.
  date +%s >"$slot_dir/last-used"
  release_slot
  (du -sk "$slot_dir" 2>/dev/null | awk '{ print $1 }' >"$slot_dir/size.tmp" && mv "$slot_dir/size.tmp" "$slot_dir/size") \
    </dev/null >/dev/null 2>&1 &
fi
if [ "$keep" != 1 ]; then rm -rf "$dir"; fi
exit "$rc"
