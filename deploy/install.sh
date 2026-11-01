#!/usr/bin/env bash
# Codex Console server installer: installs or updates the console on this server.
# deploy/deploy.sh copies the app here and runs this as root over SSH. Re-running it is
# safe: the database, workspace, Codex sign-in and secrets stay where they are.
#
#   install.sh --src DIR (--domain NAME | --ip ADDRESS) [options]
#   install.sh --check   (--domain NAME | --ip ADDRESS)     look only, change nothing
#
# Options:
#   --email ADDR      contact address for Let's Encrypt (optional)
#   --ssh-port N      the SSH port you connect on (always kept open)
#   --harden-ssh      turn off SSH password logins (needs --key-login-ok)
#   --key-login-ok    set by deploy.sh once it has logged in with an SSH key
#   --new-key NAME    also issue an API key for another device
#   --no-firewall     leave the firewall as it is
#   --lang en|zh-CN   language for messages
set -Eeuo pipefail
umask 022

APP_USER=codexconsole
# Codex runs as its own user, in a group it shares with the console for the workspace only.
AGENT_USER=codexagent
SHARED_GROUP=codexws
AGENT_SOCKET=/run/codex-console/codex.sock
APP_ROOT=/opt/codex-console
STATE=/var/lib/codex-console
ETC=/etc/codex-console
NODE_MAJOR=24
GUARD_MINUTES=10
CADDYFILE=/etc/caddy/Caddyfile
SITE_FILE=/etc/caddy/codex-console.caddy
SSHD_DROPIN=/etc/ssh/sshd_config.d/10-codex-console.conf
APPARMOR_PROFILE=/etc/apparmor.d/codex-console-codex
MARK='# Managed by the Codex Console installer: re-running it rewrites this file.'

SRC='' DOMAIN='' IP='' EMAIL='' SSH_PORT='' NEW_KEY='' UI_LANG=''
CHECK=0 HARDEN_SSH=0 KEY_LOGIN_OK=0 FIREWALL=1

while [ $# -gt 0 ]; do
  case "$1" in
    --src) SRC=${2:?--src needs a folder}; shift 2 ;;
    --domain) DOMAIN=${2:?--domain needs a name}; shift 2 ;;
    --ip) IP=${2:?--ip needs an address}; shift 2 ;;
    --email) EMAIL=${2:?--email needs an address}; shift 2 ;;
    --ssh-port) SSH_PORT=${2:?--ssh-port needs a number}; shift 2 ;;
    --new-key) NEW_KEY=${2:?--new-key needs a name}; shift 2 ;;
    --lang) UI_LANG=${2:?--lang needs en or zh-CN}; shift 2 ;;
    --check) CHECK=1; shift ;;
    --harden-ssh) HARDEN_SSH=1; shift ;;
    --key-login-ok) KEY_LOGIN_OK=1; shift ;;
    --no-firewall) FIREWALL=0; shift ;;
    -h | --help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

case "${UI_LANG:-${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}}" in zh*) ZH=1 ;; *) ZH=0 ;; esac
if [ -t 1 ]; then B=$'\033[1m' C=$'\033[36m' Y=$'\033[33m' R=$'\033[31m' G=$'\033[32m' N=$'\033[0m'; else B='' C='' Y='' R='' G='' N=''; fi
t() { if [ "$ZH" = 1 ]; then printf '%s' "$2"; else printf '%s' "$1"; fi; }
step() { printf '\n%s==>%s %s%s%s\n' "$C" "$N" "$B" "$(t "$1" "$2")" "$N"; }
info() { printf '    %s\n' "$(t "$1" "$2")"; }
ok() { printf '    %s✓%s %s\n' "$G" "$N" "$(t "$1" "$2")"; }
warn() { printf '    %s! %s%s\n' "$Y" "$(t "$1" "$2")" "$N" >&2; }
die() { printf '    %sx %s%s\n' "$R" "$(t "$1" "$2")" "$N" >&2; exit 1; }
trap 'printf "    %sx %s (line %s)%s\n" "$R" "$(t "Stopped on an error" "因出错而停止")" "$LINENO" "$N" >&2' ERR

# ---- checks -------------------------------------------------------------

is_ipv4() {
  [[ $1 =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  local o
  for o in "${BASH_REMATCH[@]:1}"; do [ "$((10#$o))" -le 255 ] || return 1; done
}
is_private_ipv4() { [[ $1 =~ ^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.) ]]; }
is_domain() { [[ $1 =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]]; }
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }
local_ips() { ip -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1; }

[ -n "$DOMAIN" ] || [ -n "$IP" ] || die 'Give --domain NAME or --ip ADDRESS.' '请提供 --domain 域名 或 --ip 地址。'
[ -z "$DOMAIN" ] || [ -z "$IP" ] || die 'Give either --domain or --ip, not both.' '--domain 和 --ip 只能选一个。'
if [ -n "$DOMAIN" ]; then
  is_domain "$DOMAIN" || die "Not a domain name: $DOMAIN" "不是有效的域名：$DOMAIN"
  DOMAIN=${DOMAIN,,}
  SITE=$DOMAIN
else
  is_ipv4 "$IP" || die "Not an IPv4 address: $IP (for IPv6, use a domain name)" "不是有效的 IPv4 地址：$IP（IPv6 请使用域名）"
  is_private_ipv4 "$IP" && die "$IP is a private address: certificates need the server's public IP." "$IP 是内网地址：证书需要服务器的公网 IP。"
  SITE=$IP
fi
[ -z "$SSH_PORT" ] || [[ $SSH_PORT =~ ^[0-9]{1,5}$ ]] || die "Not a port number: $SSH_PORT" "不是有效的端口号：$SSH_PORT"
[ -z "$EMAIL" ] || [[ $EMAIL =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die "Not an email address: $EMAIL" "不是有效的邮箱地址：$EMAIL"
[ "$(id -u)" = 0 ] || die 'Run this as root (sudo).' '请以 root 身份运行（sudo）。'

preflight() {
  local problems=0 os arch mem listeners resolved
  step 'Checking the server' '检查服务器'
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    os="${ID:-?} ${VERSION_ID:-?}"
    case "${ID:-}:${VERSION_ID:-}" in
      ubuntu:22.04 | ubuntu:24.04 | ubuntu:26.04 | debian:12 | debian:13) ok "System: $os" "系统：$os" ;;
      *)
        if command -v apt-get >/dev/null; then warn "System $os is not tested; continuing because it uses apt." "系统 $os 未经测试；因其使用 apt，继续执行。"
        else warn "System $os is not supported (needs Ubuntu or Debian)." "不支持系统 $os（需要 Ubuntu 或 Debian）。"; problems=$((problems + 1)); fi ;;
    esac
  fi
  arch=$(uname -m)
  case "$arch" in
    x86_64 | aarch64) ok "Processor: $arch" "处理器：$arch" ;;
    *) warn "Processor $arch is not supported (needs x86-64 or ARM64)." "不支持处理器 $arch（需要 x86-64 或 ARM64）。"; problems=$((problems + 1)) ;;
  esac
  command -v systemctl >/dev/null || { warn 'systemd is required.' '需要 systemd。'; problems=$((problems + 1)); }
  mem=$(awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo)
  if [ "$mem" -lt 900 ]; then warn "Only ${mem} MB of memory: 1 GB or more is recommended (swap will be added)." "内存只有 ${mem} MB：建议至少 1 GB（将添加交换空间）。"
  else ok "Memory: ${mem} MB" "内存：${mem} MB"; fi
  listeners=$(ss -Hltnp 2>/dev/null | awk '$4 ~ /:(80|443)$/' | grep -v '"caddy"' || true)
  if [ -n "$listeners" ]; then
    warn 'Something else already serves ports 80/443; stop it first:' '已有其他程序占用 80/443 端口，请先停止：'
    printf '      %s\n' "$listeners" >&2
    problems=$((problems + 1))
  else
    ok 'Ports 80 and 443 are free' '80 和 443 端口空闲'
  fi
  if [ -n "$DOMAIN" ]; then
    resolved=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | xargs || true)
    if [ -z "$resolved" ]; then
      warn "$DOMAIN does not resolve yet: point its A record at this server's public IP." "$DOMAIN 还无法解析：请把它的 A 记录指向本服务器的公网 IP。"
    elif local_ips | grep -qxF -f <(tr ' ' '\n' <<<"$resolved" | sed '/^$/d'); then
      ok "$DOMAIN points here ($resolved)" "$DOMAIN 已指向本机（$resolved）"
    else
      info "$DOMAIN points to $resolved; that must be this server's public IP (fine behind cloud NAT)." "$DOMAIN 指向 $resolved；它必须是本服务器的公网 IP（云服务器 NAT 时属正常）。"
    fi
  elif ! local_ips | grep -qxF "$IP"; then
    info "$IP is not on a network interface here; that is fine when your provider maps it to this server." "$IP 不在本机网卡上；如果云服务商把它映射到本机，这没有问题。"
  fi
  if [ -L "$APP_ROOT/current" ]; then info "Installed now: $(basename "$(readlink -f "$APP_ROOT/current")")" "当前已安装：$(basename "$(readlink -f "$APP_ROOT/current")")"; fi
  return "$problems"
}

if [ "$CHECK" = 1 ]; then
  if preflight; then ok 'Ready to install.' '可以安装。'; exit 0; fi
  exit 1
fi
preflight || die 'Fix the problems above, then run the deploy again.' '请先解决上面的问题，然后重新部署。'
if [ -z "$SRC" ] || [ ! -f "$SRC/package.json" ] || [ ! -f "$SRC/deploy/install.sh" ]; then die '--src must be the uploaded app folder.' '--src 必须是上传的应用文件夹。'; fi

# ---- packages -------------------------------------------------------------

export DEBIAN_FRONTEND=noninteractive
apt_install() { apt-get install -y -qq -o Dpkg::Options::=--force-confold "$@" >/dev/null; }

step 'Installing system packages' '安装系统软件包'
mem=$(awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo)
if [ "$mem" -lt 1800 ] && [ -z "$(swapon --show=NAME --noheadings 2>/dev/null)" ]; then
  # Building the web app needs more memory than a small server has.
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  ok 'Added 2 GB of swap' '已添加 2 GB 交换空间'
fi
apt-get update -qq
apt_install ca-certificates curl gnupg git ufw fail2ban python3-systemd unattended-upgrades
ok 'Base packages' '基础软件包'

node_ok() { command -v node >/dev/null && node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)'; }
if ! node_ok; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" >/etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt_install nodejs
fi
node_ok || die 'Node.js 22.13 or newer could not be installed.' '无法安装 Node.js 22.13 或更高版本。'
NODE_BIN=$(command -v node)
ok "Node.js $(node --version)" "Node.js $(node --version)"

if [ ! -f /etc/apt/sources.list.d/caddy-stable.list ]; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt >/etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
fi
apt_install caddy
CADDY_VERSION=$(caddy version | awk '{print $1}' | tr -d v)
ok "Caddy $CADDY_VERSION" "Caddy $CADDY_VERSION"

# ---- the app --------------------------------------------------------------

step 'Installing Codex Console' '安装 Codex Console'
getent group "$SHARED_GROUP" >/dev/null || groupadd --system "$SHARED_GROUP"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --user-group --home-dir "$STATE" --shell /usr/sbin/nologin "$APP_USER"
id -u "$AGENT_USER" >/dev/null 2>&1 || useradd --system --gid "$SHARED_GROUP" --home-dir "$STATE/agent" --shell /usr/sbin/nologin "$AGENT_USER"
usermod -aG "$SHARED_GROUP" "$APP_USER"
# An install from before Codex had its own user: Codex's folder and the workspace change hands below.
migrate=0
if [ -d "$STATE/codex-home" ] && [ "$(stat -c %U "$STATE/codex-home")" != "$AGENT_USER" ]; then migrate=1; fi
install -d -m 0750 -o "$APP_USER" -g "$SHARED_GROUP" "$STATE"
# The console's database, keys and secrets: the console only.
install -d -m 0700 -o "$APP_USER" -g "$APP_USER" "$STATE/data"
# The workspace: both, and files stay in the shared group (setgid).
install -d -m 2770 -o "$APP_USER" -g "$SHARED_GROUP" "$STATE/workspace"
# Codex's sign-in and config, and its home for tools; the console only reads saved prompts there.
install -d -m 2750 -o "$AGENT_USER" -g "$SHARED_GROUP" "$STATE/codex-home"
install -d -m 0750 -o "$AGENT_USER" -g "$SHARED_GROUP" "$STATE/agent"
if [ "$migrate" = 1 ]; then
  chown -R "$AGENT_USER:$SHARED_GROUP" "$STATE/codex-home"
  find "$STATE/codex-home" -type d -exec chmod g+rx {} +
  chgrp -R "$SHARED_GROUP" "$STATE/workspace"
  chmod -R g+rwX "$STATE/workspace"
  find "$STATE/workspace" -type d -exec chmod g+s {} +
  ok 'Moved Codex to its own user (codexagent)' '已把 Codex 移到它自己的用户（codexagent）'
fi
install -d -m 0755 "$APP_ROOT" "$APP_ROOT/releases"
install -d -m 0750 -g "$APP_USER" "$ETC"

RELEASE=$(date -u +%Y%m%d-%H%M%S)
DEST=$APP_ROOT/releases/$RELEASE
mkdir -p "$DEST"
cp -a "$SRC/." "$DEST/"
rm -rf "$DEST/node_modules" "$DEST/dist" "$DEST/.env" "$DEST/data"
chown -R "$APP_USER:$APP_USER" "$DEST"
as_app() { runuser -u "$APP_USER" -- env HOME="$STATE" PATH="$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin" "$@"; }
info 'Building (a few minutes on a small server)…' '正在构建（小服务器上需要几分钟）…'
(cd "$DEST" && as_app npm ci --no-audit --no-fund --loglevel=error && as_app npm run build --silent && as_app npm prune --omit=dev --no-audit --no-fund --loglevel=error) >/dev/null
# The service may run the code but never change it.
chown -R root:root "$DEST"
chmod -R go-w "$DEST"
ln -sfn "$DEST" "$APP_ROOT/current.new" && mv -Tf "$APP_ROOT/current.new" "$APP_ROOT/current"
find "$APP_ROOT/releases" -mindepth 1 -maxdepth 1 -type d | sort | head -n -3 | xargs -r rm -rf
ok "Release $RELEASE" "版本 $RELEASE"

write_env() {
  cat >"$ETC/env" <<EOF
$MARK
# Put your own settings in $ETC/local.env (kept across updates; see .env.example).
CC_HOST=127.0.0.1
CC_PORT=8787
CC_PUBLIC_ORIGIN=https://$1
CC_TRUST_PROXY=loopback
CC_DATA_DIR=$STATE/data
CC_WORKSPACE_ROOT=$STATE/workspace
CC_API_ENABLED=true
CC_API_HOST=127.0.0.1
CC_API_PORT=8788
CC_API_PUBLIC_ORIGIN=https://$1
CC_API_PROXY_PROTOCOL=off
CC_API_TRUST_PROXY=loopback
CC_CODEX_AGENT_SOCKET=$AGENT_SOCKET
CODEX_HOME=$STATE/codex-home
HOME=$STATE
NODE_ENV=production
EOF
  chgrp "$APP_USER" "$ETC/env" && chmod 0640 "$ETC/env"
}
cat >"$ETC/agent.env" <<EOF
$MARK
# Codex's service (codex-console-codex): where it listens and keeps its files.
CC_CODEX_AGENT_SOCKET=$AGENT_SOCKET
CODEX_HOME=$STATE/codex-home
HOME=$STATE/agent
NODE_ENV=production
EOF
chmod 0644 "$ETC/agent.env"
write_env "$SITE"
if [ ! -f "$ETC/local.env" ]; then
  printf '%s\n' '# Your own Codex Console settings (see .env.example in the app). The installer never changes this file.' >"$ETC/local.env"
  chgrp "$APP_USER" "$ETC/local.env" && chmod 0640 "$ETC/local.env"
fi

cat >/usr/local/bin/codex-console <<EOF
#!/usr/bin/env bash
# Manage Codex Console on this server (run with sudo):
#   codex-console setup [--new-key NAME | --list-keys | --revoke-key ID | --sign-out-all | --reset-password | --reset-totp]
#   codex-console status | logs | restart | confirm
set -euo pipefail
[ "\$(id -u)" = 0 ] || { echo "Run with sudo: sudo codex-console \$*" >&2; exit 1; }
cmd=\${1:-help}
[ \$# -gt 0 ] && shift
case "\$cmd" in
  setup)
    set -a
    . $ETC/env
    [ -f $ETC/local.env ] && . $ETC/local.env
    set +a
    cd $APP_ROOT/current
    exec runuser -u $APP_USER -- $NODE_BIN dist/server/cli/setup.js "\$@" ;;
  status) exec systemctl --no-pager status codex-console codex-console-codex caddy ;;
  logs) exec journalctl -u codex-console -u codex-console-codex -f ;;
  restart) systemctl restart codex-console-codex && exec systemctl restart codex-console ;;
  confirm) systemctl stop codex-console-guard.timer 2>/dev/null || true ;;
  *) sed -n '2,4p' "\$0" ;;
esac
EOF
chmod 0755 /usr/local/bin/codex-console

cat >/etc/systemd/system/codex-console-codex.service <<EOF
$MARK
[Unit]
Description=Codex for Codex Console (runs Codex as its own user)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$AGENT_USER
Group=$SHARED_GROUP
WorkingDirectory=$STATE/agent
EnvironmentFile=$ETC/agent.env
ExecStart=$NODE_BIN $APP_ROOT/current/dist/server/cli/codex-agent.js
Restart=on-failure
RestartSec=3
TimeoutStopSec=20
RuntimeDirectory=codex-console
RuntimeDirectoryMode=0750
UMask=0007
LimitNOFILE=65536
# Codex may write only to the workspace and its own folders, and never sees the console's
# data, even in full-access mode. Options that cover /proc or /sys are left out: Codex
# mounts its own /proc for its sandbox.
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=$STATE/workspace $STATE/codex-home $STATE/agent
InaccessiblePaths=$STATE/data
ProtectHome=yes
ProtectKernelModules=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
LockPersonality=yes

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/codex-console.service <<EOF
$MARK
[Unit]
Description=Codex Console
After=network-online.target codex-console-codex.service
Wants=network-online.target codex-console-codex.service
# Same /tmp as Codex, so the console can show images Codex saved there.
JoinsNamespaceOf=codex-console-codex.service

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
SupplementaryGroups=$SHARED_GROUP
WorkingDirectory=$APP_ROOT/current
EnvironmentFile=$ETC/env
EnvironmentFile=-$ETC/local.env
ExecStart=$NODE_BIN dist/server/index.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0007
LimitNOFILE=65536
# Everything outside $STATE is read-only. Codex runs in codex-console-codex.service.
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=$STATE
ProtectHome=yes
ProtectKernelModules=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
LockPersonality=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload

# ---- owner account and keys ---------------------------------------------

if ! /usr/local/bin/codex-console setup --is-set-up; then
  step 'Admin password, authenticator and your first API key' '管理员密码、验证器和你的第一把 API 密钥'
  if [ -t 0 ] && [ -t 1 ]; then
    /usr/local/bin/codex-console setup ${UI_LANG:+--lang "$UI_LANG"} || warn "Setup did not finish: run 'sudo codex-console setup' later." "设置未完成：稍后请运行 'sudo codex-console setup'。"
  else
    warn "No terminal here: run 'sudo codex-console setup' on the server to finish." "当前没有终端：请在服务器上运行 'sudo codex-console setup' 完成设置。"
  fi
elif [ -n "$NEW_KEY" ]; then
  /usr/local/bin/codex-console setup --new-key "$NEW_KEY" ${UI_LANG:+--lang "$UI_LANG"}
fi

step 'Starting the console' '启动控制台'
systemctl enable --quiet codex-console-codex codex-console
systemctl restart codex-console-codex
systemctl restart codex-console
up=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 -H 'Host: 127.0.0.1:8787' http://127.0.0.1:8787/api/health >/dev/null 2>&1; then up=1; break; fi
  sleep 1
done
[ "$up" = 1 ] || { journalctl -u codex-console -n 30 --no-pager >&2 || true; die 'The console did not start (log above).' '控制台未能启动（见上面的日志）。'; }
ok 'Console is running on 127.0.0.1:8787, the API on 127.0.0.1:8788' '控制台运行在 127.0.0.1:8787，API 运行在 127.0.0.1:8788'
if systemctl is-active --quiet codex-console-codex && [ -S "$AGENT_SOCKET" ]; then
  ok "Codex runs as its own user ($AGENT_USER)" "Codex 以它自己的用户运行（$AGENT_USER）"
else
  journalctl -u codex-console-codex -n 20 --no-pager >&2 || true
  warn "Codex's service did not start (log above): sudo codex-console logs" 'Codex 的服务未能启动（见上面的日志）：sudo codex-console logs'
fi
# The point of the separate user: Codex must not see the console's database, keys or secrets.
if runuser -u "$AGENT_USER" -- ls "$STATE/data" >/dev/null 2>&1; then
  warn "Codex's user can read $STATE/data: fix its permissions (owner $APP_USER, mode 0700)." "Codex 的用户可以读取 $STATE/data：请修正其权限（所有者 $APP_USER，权限 0700）。"
else
  ok "Codex cannot read the console's data" 'Codex 无法读取控制台的数据'
fi

# ---- HTTPS ----------------------------------------------------------------

render_site() { # $1 = site address
  echo "$MARK"
  echo "$1 {"
  if is_ipv4 "$1"; then
    # Let's Encrypt certificates for IP addresses are short-lived (about 6 days); Caddy renews them.
    printf '\ttls {\n\t\tissuer acme {\n\t\t\tprofile shortlived\n'
    [ -z "$EMAIL" ] || printf '\t\t\temail %s\n' "$EMAIL"
    printf '\t\t}\n\t}\n'
  elif [ -n "$EMAIL" ]; then
    printf '\ttls %s\n' "$EMAIL"
  fi
  cat <<'EOF'
	@static path /assets/*
	encode @static zstd gzip
	header -Server
	@api path /v1 /v1/*
	handle @api {
		reverse_proxy 127.0.0.1:8788 {
			flush_interval -1
		}
	}
	handle {
		reverse_proxy 127.0.0.1:8787 {
			flush_interval -1
		}
	}
}
EOF
}

is_stock_caddyfile() { [ "$(grep -vE '^[[:space:]]*(#|$)' "$CADDYFILE" 2>/dev/null | tr -d '[:space:]')" = ':80{root*/usr/share/caddyfile_server}' ]; }

write_caddy() { # $1 = site address; a broken config never replaces a working one
  local main tmpmain from="import $SITE_FILE" to="import $SITE_FILE.new"
  render_site "$1" >"$SITE_FILE.new"
  if [ ! -f "$CADDYFILE" ] || is_stock_caddyfile || grep -qF "$MARK" "$CADDYFILE"; then
    [ ! -f "$CADDYFILE" ] || grep -qF "$MARK" "$CADDYFILE" || [ -e "$CADDYFILE.orig" ] || cp "$CADDYFILE" "$CADDYFILE.orig"
    main=$(printf '%s\nimport %s\n' "$MARK" "$SITE_FILE")
  elif grep -qF "import $SITE_FILE" "$CADDYFILE"; then
    main=$(cat "$CADDYFILE")
  else
    main=$(printf '%s\n\nimport %s\n' "$(cat "$CADDYFILE")" "$SITE_FILE")
  fi
  tmpmain=$(mktemp "$(dirname "$CADDYFILE")/.validate.XXXXXX")
  printf '%s\n' "${main//"$from"/"$to"}" >"$tmpmain"
  if ! caddy validate --adapter caddyfile --config "$tmpmain" >/dev/null 2>&1; then
    caddy validate --adapter caddyfile --config "$tmpmain" 2>&1 | tail -n 5 >&2 || true
    rm -f "$tmpmain" "$SITE_FILE.new"
    return 1
  fi
  rm -f "$tmpmain"
  mv -f "$SITE_FILE.new" "$SITE_FILE"
  printf '%s\n' "$main" >"$CADDYFILE"
  systemctl enable --quiet caddy
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
}

https_ok() { curl -fsS --max-time 10 --connect-to "$1:443:127.0.0.1:443" "https://$1/api/health" >/dev/null 2>&1; }
wait_https() {
  local _
  for _ in $(seq 1 36); do https_ok "$1" && return 0; sleep 5; done
  return 1
}

step 'HTTPS certificate' 'HTTPS 证书'
use_sslip=0
if is_ipv4 "$SITE" && ! version_ge "$CADDY_VERSION" 2.10.0; then
  warn "Caddy $CADDY_VERSION cannot get certificates for IP addresses; using $SITE.sslip.io instead." "Caddy $CADDY_VERSION 无法为 IP 地址申请证书；改用 $SITE.sslip.io。"
  use_sslip=1
elif ! write_caddy "$SITE"; then
  if is_ipv4 "$SITE"; then use_sslip=1; else die 'Caddy rejected the configuration (above).' 'Caddy 拒绝了该配置（见上方）。'; fi
fi
if [ "$use_sslip" = 0 ]; then
  info "Waiting for Let's Encrypt (up to 3 minutes)…" '等待 Let'"'"'s Encrypt 签发证书（最多 3 分钟）…'
  if wait_https "$SITE"; then
    ok "https://$SITE has a valid certificate" "https://$SITE 已获得有效证书"
  elif is_ipv4 "$SITE"; then
    warn "No certificate for the bare IP; switching to $SITE.sslip.io." "无法为纯 IP 签发证书；改用 $SITE.sslip.io。"
    use_sslip=1
  else
    journalctl -u caddy --since '-5min' --no-pager 2>/dev/null | grep -iE 'error|challenge' | tail -n 5 >&2 || true
    warn "No certificate yet. Check that $DOMAIN points here and that ports 80 and 443 are open in your provider's firewall; Caddy keeps retrying." "尚未获得证书。请确认 $DOMAIN 指向本机，并在云服务商的防火墙中开放 80 和 443 端口；Caddy 会持续重试。"
  fi
fi
if [ "$use_sslip" = 1 ]; then
  # sslip.io is a public DNS service that resolves <ip>.sslip.io to <ip>.
  SITE="$IP.sslip.io"
  write_env "$SITE"
  systemctl restart codex-console
  write_caddy "$SITE" || die 'Caddy rejected the configuration (above).' 'Caddy 拒绝了该配置（见上方）。'
  if wait_https "$SITE"; then ok "https://$SITE has a valid certificate" "https://$SITE 已获得有效证书"
  else warn "No certificate for $SITE yet; check that ports 80 and 443 are open. Caddy keeps retrying." "$SITE 尚未获得证书；请检查 80 和 443 端口是否开放。Caddy 会持续重试。"; fi
fi

# ---- Codex sandbox ---------------------------------------------------------

step "Codex's sandbox" 'Codex 沙箱'
CODEX_BIN=$(cd "$APP_ROOT/current" && "$NODE_BIN" -e 'import("./dist/server/config.js").then((m) => console.log(m.resolvePinnedCodexBin() ?? ""))')
# Checked the way Codex's service runs it: as its own user, with the same restrictions.
sandbox_works() {
  [ -n "$CODEX_BIN" ] && systemd-run --quiet --wait --pipe --collect -p User="$AGENT_USER" -p Group="$SHARED_GROUP" -p NoNewPrivileges=yes -p PrivateTmp=yes \
    -p ProtectSystem=strict -p ReadWritePaths="$STATE/workspace $STATE/codex-home $STATE/agent" -p InaccessiblePaths="$STATE/data" -p ProtectHome=yes \
    --setenv=HOME="$STATE/agent" --setenv=CODEX_HOME="$STATE/codex-home" "$CODEX_BIN" sandbox -- /bin/true >/dev/null 2>&1
}
if sandbox_works; then
  ok "Codex $("$CODEX_BIN" --version 2>/dev/null | awk '{print $2}') can sandbox commands here" "Codex $("$CODEX_BIN" --version 2>/dev/null | awk '{print $2}') 可以在本机使用沙箱运行命令"
elif [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ] && [ -f /etc/apparmor.d/abi/4.0 ] && command -v apparmor_parser >/dev/null; then
  # Ubuntu 23.10+ blocks the user namespaces Codex's sandbox needs; allow them for this one binary.
  cat >"$APPARMOR_PROFILE" <<EOF
$MARK
abi <abi/4.0>,
include <tunables/global>

profile codex-console-codex $APP_ROOT/releases/*/node_modules/@openai/codex-linux-*/vendor/*/bin/codex flags=(unconfined) {
  userns,
  include if exists <local/codex-console-codex>
}
EOF
  apparmor_parser -r "$APPARMOR_PROFILE"
  if sandbox_works; then ok 'Allowed the user namespaces Codex needs (AppArmor profile for Codex only)' '已允许 Codex 所需的用户命名空间（仅针对 Codex 的 AppArmor 配置）'
  else warn "Codex's sandbox still fails here; sandboxed commands will not run (see the deploy guide)." 'Codex 沙箱在本机仍然失败；沙箱中的命令将无法运行（见部署指南）。'; fi
else
  warn "Codex's sandbox does not work here; sandboxed commands will not run (see the deploy guide)." 'Codex 沙箱在本机无法工作；沙箱中的命令将无法运行（见部署指南）。'
fi

# ---- firewall, fail2ban, updates, SSH ----------------------------------------

ssh_ports() {
  {
    sshd -T 2>/dev/null | awk '$1 == "port" {print $2}'
    [ -z "$SSH_PORT" ] || echo "$SSH_PORT"
    [ -z "${SSH_CONNECTION:-}" ] || echo "${SSH_CONNECTION##* }"
  } | grep -E '^[0-9]+$' | sort -un
}
PORTS=$(ssh_ports)
[ -n "$PORTS" ] || PORTS=22
PORTS_CSV=$(printf '%s\n' "$PORTS" | paste -sd, -)

arm_guard() {
  # Undo the firewall and SSH changes unless deploy.sh confirms a new SSH login in time.
  cat >/usr/local/sbin/codex-console-guard <<EOF
#!/bin/sh
ufw --force disable >/dev/null 2>&1 || true
if [ -f $SSHD_DROPIN ]; then rm -f $SSHD_DROPIN; systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true; fi
logger -t codex-console "guard: no confirmed SSH login, firewall turned off and SSH settings restored"
EOF
  chmod 0755 /usr/local/sbin/codex-console-guard
  systemctl stop codex-console-guard.timer codex-console-guard.service 2>/dev/null || true
  systemd-run --quiet --unit codex-console-guard --on-active="${GUARD_MINUTES}min" /usr/local/sbin/codex-console-guard
  GUARDED=1
}
GUARDED=0

if [ "$FIREWALL" = 1 ]; then
  step 'Firewall' '防火墙'
  if ufw status | grep -q '^Status: active'; then
    was_active=1
  else
    was_active=0
    ufw default deny incoming >/dev/null
    ufw default allow outgoing >/dev/null
  fi
  for p in $PORTS; do ufw allow "$p/tcp" comment 'SSH' >/dev/null; done
  ufw allow 80/tcp comment 'HTTP (certificates, redirect)' >/dev/null
  ufw allow 443/tcp comment 'HTTPS' >/dev/null
  ufw allow 443/udp comment 'HTTP/3' >/dev/null
  if [ "$was_active" = 0 ]; then
    arm_guard
    ufw --force enable >/dev/null
  fi
  ok "Open: SSH ($PORTS_CSV), 80 and 443; everything else is blocked" "已开放：SSH（$PORTS_CSV）、80 和 443；其余全部拦截"
fi

step 'Brute-force protection and security updates' '暴力破解防护与安全更新'
cat >/etc/fail2ban/jail.d/codex-console.local <<EOF
$MARK
[sshd]
enabled = true
backend = systemd
port = $PORTS_CSV
maxretry = 5
findtime = 10m
bantime = 1h

[recidive]
enabled = true
EOF
systemctl enable --quiet fail2ban
systemctl restart fail2ban || warn 'fail2ban did not start (see: journalctl -u fail2ban).' 'fail2ban 未能启动（见：journalctl -u fail2ban）。'
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
systemctl enable --quiet unattended-upgrades 2>/dev/null || true
ok 'fail2ban watches SSH; security updates install automatically' 'fail2ban 已监控 SSH；安全更新会自动安装'

if [ "$HARDEN_SSH" = 1 ]; then
  step 'SSH: keys only' 'SSH：仅允许密钥登录'
  if [ "$KEY_LOGIN_OK" != 1 ]; then
    warn 'Skipped: only done when deploy.sh has logged in with an SSH key.' '已跳过：只有 deploy.sh 用 SSH 密钥成功登录后才会执行。'
  else
    printf '%s\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' "$MARK" >"$SSHD_DROPIN"
    if sshd -t 2>/dev/null; then
      [ "$GUARDED" = 1 ] || arm_guard
      systemctl reload ssh 2>/dev/null || systemctl reload sshd
      ok 'Password logins are off' '已关闭密码登录'
    else
      rm -f "$SSHD_DROPIN"
      warn 'sshd rejected the change; nothing was changed.' 'sshd 拒绝了该修改；未做任何更改。'
    fi
  fi
fi

case "$SRC" in /tmp/codex-console-upload-*) rm -rf "$SRC" ;; esac
trap - ERR

printf '\n%s%s%s\n' "$B" "$(t 'Codex Console is ready' 'Codex Console 已就绪')" "$N"
printf '  %s  %shttps://%s%s\n' "$(t 'Open:' '打开：')" "$G" "$SITE" "$N"
info '1. Sign in with your API key (printed above on the first install).' '1. 用你的 API 密钥登录（首次安装时已在上方输出）。'
info '2. Admin (password + authenticator code) → Codex → sign in with ChatGPT.' '2. 管理后台（密码 + 验证器动态码）→ Codex → 用 ChatGPT 登录。'
info "Another device: sudo codex-console setup --new-key \"Phone\"" "其他设备：sudo codex-console setup --new-key \"手机\""
info 'Update: run deploy.sh again with the same options.   Logs: sudo codex-console logs' '更新：用相同参数再次运行 deploy.sh。   日志：sudo codex-console logs'
if [ "$GUARDED" = 1 ]; then
  warn "Safety timer: the firewall and SSH changes undo themselves in $GUARD_MINUTES minutes unless a new SSH login confirms them (deploy.sh does this; by hand: sudo codex-console confirm)." "安全计时器：除非有新的 SSH 登录确认（deploy.sh 会自动完成；手动：sudo codex-console confirm），防火墙和 SSH 的修改会在 $GUARD_MINUTES 分钟后自动撤销。"
fi
