#!/usr/bin/env bash
# Deploy Codex Console to your own Linux server in one command. Run it from this repository
# on your computer: it needs ssh and tar, and copies only the files git tracks (never .env,
# data or keys). Run it again with the same options to update.
#
#   deploy/deploy.sh root@203.0.113.7 --ip 203.0.113.7
#   deploy/deploy.sh me@my-server --domain console.example.com --email me@example.com
#
# Options:
#   --domain NAME     serve on this domain (its DNS A record must point at the server)
#   --ip ADDRESS      serve on the server's public IPv4 address (no domain needed)
#   --email ADDR      contact address for Let's Encrypt (optional)
#   --port N          SSH port (default 22)
#   --identity FILE   SSH private key to use
#   --new-key NAME    also issue an API key for another device
#   --harden-ssh      turn off SSH password logins (only after your key login works)
#   --no-firewall     leave the server's firewall as it is
#   --check           only check the server and change nothing (also: --dry-run)
#   --lang en|zh-CN   language for messages
set -Eeuo pipefail

TARGET='' DOMAIN='' IP='' EMAIL='' PORT=22 IDENTITY='' NEW_KEY='' UI_LANG=''
CHECK=0 HARDEN_SSH=0 FIREWALL=1

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN=${2:?--domain needs a name}; shift 2 ;;
    --ip) IP=${2:?--ip needs an address}; shift 2 ;;
    --email) EMAIL=${2:?--email needs an address}; shift 2 ;;
    --port) PORT=${2:?--port needs a number}; shift 2 ;;
    --identity) IDENTITY=${2:?--identity needs a file}; shift 2 ;;
    --new-key) NEW_KEY=${2:?--new-key needs a name}; shift 2 ;;
    --lang) UI_LANG=${2:?--lang needs en or zh-CN}; shift 2 ;;
    --check | --dry-run) CHECK=1; shift ;;
    --harden-ssh) HARDEN_SSH=1; shift ;;
    --no-firewall) FIREWALL=0; shift ;;
    -h | --help) sed -n '2,21p' "$0"; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; exit 2 ;;
    *) [ -z "$TARGET" ] || { echo "Only one server, please: $1" >&2; exit 2; }; TARGET=$1; shift ;;
  esac
done

case "${UI_LANG:-${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}}" in zh*) ZH=1 ;; *) ZH=0 ;; esac
if [ -t 1 ]; then B=$'\033[1m' C=$'\033[36m' Y=$'\033[33m' R=$'\033[31m' G=$'\033[32m' N=$'\033[0m'; else B='' C='' Y='' R='' G='' N=''; fi
t() { if [ "$ZH" = 1 ]; then printf '%s' "$2"; else printf '%s' "$1"; fi; }
step() { printf '\n%s==>%s %s%s%s\n' "$C" "$N" "$B" "$(t "$1" "$2")" "$N"; }
ok() { printf '    %s✓%s %s\n' "$G" "$N" "$(t "$1" "$2")"; }
warn() { printf '    %s! %s%s\n' "$Y" "$(t "$1" "$2")" "$N" >&2; }
die() { printf '    %sx %s%s\n' "$R" "$(t "$1" "$2")" "$N" >&2; exit 1; }
# Quote one word for the remote shell (POSIX sh, whatever the login shell is).
q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

[ -n "$TARGET" ] || die 'Name the server, e.g. deploy/deploy.sh root@203.0.113.7 --ip 203.0.113.7' '请指定服务器，例如：deploy/deploy.sh root@203.0.113.7 --ip 203.0.113.7'
[ -n "$DOMAIN" ] || [ -n "$IP" ] || die 'Give --domain NAME or --ip ADDRESS.' '请提供 --domain 域名 或 --ip 地址。'
[ -z "$DOMAIN" ] || [ -z "$IP" ] || die 'Give either --domain or --ip, not both.' '--domain 和 --ip 只能选一个。'
[[ $PORT =~ ^[0-9]{1,5}$ ]] || die "Not a port number: $PORT" "不是有效的端口号：$PORT"
for tool in ssh tar; do command -v "$tool" >/dev/null || die "$tool is needed on this computer." "本机需要 $tool。"; done
ROOT=$(cd "$(dirname "$0")/.." && pwd)
if [ ! -f "$ROOT/package.json" ] || [ ! -f "$ROOT/deploy/install.sh" ]; then die 'Run this from the Codex Console repository.' '请在 Codex Console 仓库中运行。'; fi

CTL=$(mktemp -d "${TMPDIR:-/tmp}/cc-deploy.XXXXXX")
SSH=(-p "$PORT" -o ConnectTimeout=15 -o ServerAliveInterval=30)
[ -z "$IDENTITY" ] || SSH+=(-i "$IDENTITY")
# One SSH connection for the whole deploy, so a password (if you use one) is asked once.
MUX=(-o ControlMaster=auto -o "ControlPath=$CTL/%C" -o ControlPersist=10m)
cleanup() {
  ssh "${SSH[@]}" "${MUX[@]}" -O exit "$TARGET" >/dev/null 2>&1 || true
  rm -rf "$CTL"
}
trap cleanup EXIT
# shellcheck disable=SC2029 # the command line is meant to be built here
remote() { ssh "${SSH[@]}" "${MUX[@]}" "$TARGET" "$@"; }

step "Connecting to $TARGET" "连接 $TARGET"
KEY_LOGIN=0
if ssh "${SSH[@]}" -o BatchMode=yes "$TARGET" true 2>/dev/null; then
  KEY_LOGIN=1
  ok 'Logged in with an SSH key' '已用 SSH 密钥登录'
else
  [ "$HARDEN_SSH" = 0 ] || die "--harden-ssh needs a working SSH key login first (ssh-copy-id -p $PORT $TARGET)." "--harden-ssh 需要先能用 SSH 密钥登录（ssh-copy-id -p $PORT $TARGET）。"
  warn "No SSH key login: you will be asked for the server password (setting up a key is safer: ssh-copy-id -p $PORT $TARGET)." "未能用 SSH 密钥登录：将要求输入服务器密码（更安全的做法是设置密钥：ssh-copy-id -p $PORT $TARGET）。"
fi
remote true || die "Cannot log in to $TARGET." "无法登录 $TARGET。"
if [ "$(remote id -u)" = 0 ]; then SUDO=''; else
  remote 'command -v sudo >/dev/null' || die 'The SSH user is not root and sudo is missing.' 'SSH 用户不是 root，且没有 sudo。'
  SUDO='sudo'
fi

ARGS=()
if [ -n "$DOMAIN" ]; then ARGS+=(--domain "$DOMAIN"); else ARGS+=(--ip "$IP"); fi
[ -z "$EMAIL" ] || ARGS+=(--email "$EMAIL")
[ -z "$NEW_KEY" ] || ARGS+=(--new-key "$NEW_KEY")
[ -z "$UI_LANG" ] || ARGS+=(--lang "$UI_LANG")
[ "$HARDEN_SSH" = 0 ] || ARGS+=(--harden-ssh)
[ "$KEY_LOGIN" = 0 ] || ARGS+=(--key-login-ok)
[ "$FIREWALL" = 1 ] || ARGS+=(--no-firewall)
ARGS+=(--ssh-port "$PORT")
QARGS=''
for a in "${ARGS[@]}"; do QARGS+=" $(q "$a")"; done

# Random names from mktemp, so nobody else on the server can prepare these paths in advance.
remote_tmp() {
  local path
  path=$(remote "mktemp $1 /tmp/$2-XXXXXXXXXX")
  [[ $path =~ ^/tmp/$2-[A-Za-z0-9]{10}$ ]] || die "Unexpected temporary path on the server: $path" "服务器上的临时路径异常：$path"
  printf '%s' "$path"
}

if [ "$CHECK" = 1 ]; then
  CHECK_FILE=$(remote_tmp '' codex-console-check)
  remote "cat > $CHECK_FILE" <"$ROOT/deploy/install.sh"
  status=0
  ssh -t "${SSH[@]}" "${MUX[@]}" "$TARGET" "$SUDO bash $CHECK_FILE --check$QARGS; s=\$?; rm -f $CHECK_FILE; exit \$s" || status=$?
  exit "$status"
fi

step 'Uploading the app' '上传应用'
UPLOAD=$(remote_tmp -d codex-console-upload)
export COPYFILE_DISABLE=1 # no macOS ._ files in the archive
list_files() {
  if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    # Tracked and new files, minus everything .gitignore excludes (.env, data, node_modules, keys),
    # minus the deploy program (it runs on your computer, not the server).
    local f
    while IFS= read -r -d '' f; do
      case "$f" in deployer/* | .github/*) continue ;; esac
      if [ -e "$ROOT/$f" ]; then printf '%s\0' "$f"; fi
    done < <(git -C "$ROOT" ls-files -z -co --exclude-standard)
  else
    (cd "$ROOT" && find . -type f ! -path './node_modules/*' ! -path './dist/*' ! -path './.git/*' ! -path './data/*' ! -path './deployer/*' ! -path './.github/*' ! -name '.env*' ! -name '*.db*' ! -name '*.pem' ! -name '*.key' -print0)
  fi
}
count=$(list_files | tr -cd '\0' | wc -c | tr -d ' ')
list_files | (cd "$ROOT" && tar --null -T - -czf -) | remote "tar -xzf - -C $UPLOAD"
ok "$count files" "$count 个文件"

step 'Installing on the server' '在服务器上安装'
status=0
ssh -t "${SSH[@]}" "${MUX[@]}" "$TARGET" "$SUDO bash $UPLOAD/deploy/install.sh --src $UPLOAD$QARGS" || status=$?

# A new connection (not the shared one) proves SSH still works after the firewall changes;
# that stops the safety timer that would otherwise undo them.
step 'Checking that SSH still works' '检查 SSH 是否仍可登录'
FRESH=(-o ControlMaster=no -o ControlPath=none)
[ "$KEY_LOGIN" = 0 ] || FRESH+=(-o BatchMode=yes)
if ssh -t "${SSH[@]}" "${FRESH[@]}" "$TARGET" "$SUDO sh -c 'systemctl stop codex-console-guard.timer 2>/dev/null; ! systemctl is-active --quiet codex-console-guard.timer'" 2>/dev/null; then
  ok 'New SSH login works; firewall and SSH changes are kept' '新的 SSH 登录正常；防火墙和 SSH 的修改已保留'
else
  warn "Could not confirm a new SSH login. If you can still log in, run 'sudo codex-console confirm' on the server within 10 minutes, or the firewall and SSH changes undo themselves." "无法确认新的 SSH 登录。如果你仍能登录，请在 10 分钟内在服务器上运行 'sudo codex-console confirm'，否则防火墙和 SSH 的修改会自动撤销。"
fi

[ "$status" = 0 ] || die "The install stopped with an error (exit $status); fix it and run the same command again." "安装因错误而停止（退出码 $status）；解决后请重新运行同一命令。"
printf '\n%s%s%s\n' "$B" "$(t 'Done. Open the link shown above.' '完成。打开上面显示的链接。')" "$N"
