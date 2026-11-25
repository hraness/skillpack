/*
 * HostRun UI: the launchd program for forwarded host-run mac-ui jobs.
 *
 * macOS privacy controls (TCC) grant Accessibility, Screen Recording and
 * Input Monitoring to the process launchd started, and every child it spawns
 * inherits that attribution. Running the job through this small app bundle,
 * instead of /bin/bash, lets the owner grant those permissions to this one
 * app rather than to every shell on the machine.
 *
 * It runs exactly one thing: the job script host-run's remote driver staged
 * in a run directory under $HOME/.local/state/host-run/remote/<id>. It
 * refuses to start unless all of these hold:
 *   - argv is exactly: run <run-dir> <token>
 *   - launchd started it (parent pid 1) as the job
 *     dev.hraness.host-run.mac-ui.<id>
 *   - <run-dir> is a real directory directly under that state root, owned
 *     by this user, with no group or other access
 *   - <run-dir>/helper-token is a 0600 regular file owned by this user whose
 *     content equals <token>; it is removed before the job starts, so a run
 *     directory can start one job only
 *   - <run-dir>/job.sh is a regular file owned by this user, mode 0700
 * It then spawns /bin/bash job.sh as a child (never exec, so the child keeps
 * this app as its responsible process), forwards TERM, INT and HUP to it, and
 * exits with its status (128 + signal when it was killed).
 *
 * This is not a security boundary against code already running as this user:
 * such code can stage a run directory and load a launchd job the same way the
 * driver does. It keeps the grant from being reachable through an arbitrary
 * argv, a shell, or a stale run directory.
 *
 * Changing this file changes the binary and its ad-hoc signature, which
 * invalidates the owner's grants. Keep it small and change it rarely.
 */
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pwd.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#define REFUSED 69
#define LABEL_PREFIX "dev.hraness.host-run.mac-ui."
#define TOKEN_MAX 128

extern char **environ;
static volatile sig_atomic_t child_pid = 0;
static volatile sig_atomic_t pending_signal = 0;

static int refuse(const char *reason) {
  fprintf(stderr, "[HostRun UI] refused: %s\n", reason);
  return REFUSED;
}

static void forward_signal(int signal_number) {
  if (child_pid > 0) kill(child_pid, signal_number);
  else pending_signal = signal_number;
}

static int valid_id(const char *id) {
  if (*id == '\0') return 0;
  for (const char *c = id; *c; c++) {
    if (!((*c >= 'A' && *c <= 'Z') || (*c >= 'a' && *c <= 'z') || (*c >= '0' && *c <= '9') || *c == '-')) return 0;
  }
  return 1;
}

static int private_regular_file(const char *path, mode_t mode) {
  struct stat info;
  if (lstat(path, &info) != 0) return 0;
  return S_ISREG(info.st_mode) && info.st_uid == getuid() && (info.st_mode & 07777) == mode;
}

static int read_token(const char *path, char *out, size_t size) {
  int fd = open(path, O_RDONLY | O_NOFOLLOW);
  if (fd < 0) return 0;
  ssize_t length = read(fd, out, size - 1);
  close(fd);
  if (length <= 0) return 0;
  out[length] = '\0';
  if (out[length - 1] == '\n') out[length - 1] = '\0';
  return 1;
}

int main(int argc, char **argv) {
  if (argc != 4 || strcmp(argv[1], "run") != 0) return refuse("usage: host-run-ui run <run-dir> <token>");
  if (getppid() != 1) return refuse("only launchd may start a host-run mac-ui job");

  /* HOME is what the driver used to build the run directory; it comes from launchd. */
  const char *home = getenv("HOME");
  if (home == NULL || home[0] != '/') {
    const struct passwd *user = getpwuid(getuid());
    if (user == NULL || user->pw_dir == NULL) return refuse("cannot resolve this user's home directory");
    home = user->pw_dir;
  }
  char state_root[PATH_MAX];
  char resolved_root[PATH_MAX];
  if (snprintf(state_root, sizeof state_root, "%s/.local/state/host-run/remote", home) >= (int)sizeof state_root) {
    return refuse("home directory path is too long");
  }
  if (realpath(state_root, resolved_root) == NULL) return refuse("no host-run remote state directory");

  const char *run_dir = argv[2];
  const char *slash = strrchr(run_dir, '/');
  if (slash == NULL) return refuse("run directory must be an absolute path");
  const char *id = slash + 1;
  if (!valid_id(id)) return refuse("run directory name is not a host-run run id");
  char parent[PATH_MAX];
  size_t parent_length = (size_t)(slash - run_dir);
  if (parent_length == 0 || parent_length >= sizeof parent) return refuse("run directory path is invalid");
  memcpy(parent, run_dir, parent_length);
  parent[parent_length] = '\0';
  char resolved_parent[PATH_MAX];
  if (realpath(parent, resolved_parent) == NULL || strcmp(resolved_parent, resolved_root) != 0) {
    return refuse("run directory is not directly under ~/.local/state/host-run/remote");
  }
  char job_dir[PATH_MAX];
  if (snprintf(job_dir, sizeof job_dir, "%s/%s", resolved_root, id) >= (int)sizeof job_dir) return refuse("run directory path is too long");
  struct stat dir_info;
  if (lstat(job_dir, &dir_info) != 0 || !S_ISDIR(dir_info.st_mode)) return refuse("run directory is missing or not a directory");
  if (dir_info.st_uid != getuid() || (dir_info.st_mode & 077) != 0) return refuse("run directory must be private to this user");

  const char *service = getenv("XPC_SERVICE_NAME");
  char expected_label[PATH_MAX];
  snprintf(expected_label, sizeof expected_label, "%s%s", LABEL_PREFIX, id);
  if (service == NULL || strcmp(service, expected_label) != 0) return refuse("launchd job label does not match the run directory");

  char token_path[PATH_MAX];
  char token[TOKEN_MAX + 2];
  snprintf(token_path, sizeof token_path, "%s/helper-token", job_dir);
  if (!private_regular_file(token_path, 0600)) return refuse("run directory has no private one-time token");
  if (!read_token(token_path, token, sizeof token)) return refuse("could not read the one-time token");
  if (strlen(argv[3]) < 16 || strlen(argv[3]) > TOKEN_MAX || strcmp(token, argv[3]) != 0) return refuse("token does not match");
  if (unlink(token_path) != 0) return refuse("could not consume the one-time token");

  char job_path[PATH_MAX];
  snprintf(job_path, sizeof job_path, "%s/job.sh", job_dir);
  if (!private_regular_file(job_path, 0700)) return refuse("job.sh must be a private 0700 file owned by this user");

  struct sigaction action;
  memset(&action, 0, sizeof action);
  action.sa_handler = forward_signal;
  sigemptyset(&action.sa_mask);
  sigaction(SIGTERM, &action, NULL);
  sigaction(SIGINT, &action, NULL);
  sigaction(SIGHUP, &action, NULL);

  char *child_argv[] = {"/bin/bash", job_path, NULL};
  pid_t pid;
  int spawn_error = posix_spawn(&pid, "/bin/bash", NULL, NULL, child_argv, environ);
  if (spawn_error != 0) {
    fprintf(stderr, "[HostRun UI] could not start the job: %s\n", strerror(spawn_error));
    return REFUSED;
  }
  child_pid = pid;
  if (pending_signal != 0) kill(pid, pending_signal);

  int status = 0;
  while (waitpid(pid, &status, 0) < 0) {
    if (errno != EINTR) return 1;
  }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 1;
}
