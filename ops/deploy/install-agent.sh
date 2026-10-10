#!/usr/bin/env bash
# 卫戍协议探针一键安装（collector + 管理 Agent）。在每台游戏服务器上以 root 运行一次。
#
# 前置：部署包（dist/sp-ops-agent.zip）已解压到 /opt/stronghold-ops（或用 APP_DIR 指定），
#       服务器有 Node.js >= 22，本站令牌已在中间页 /etc/stronghold/portal.env 配置为 SP_SITE_*_TOKEN_RO。
#
# 用法（十堰示例，香港替换名称/日志/容量即可）。APP_DIR 默认 /opt/stronghold-ops（zip 布局）；
# 游戏仓库布局（探针在游戏仓库 ops/ 下，随 git pull 更新）则传 APP_DIR=/opt/Stronghold-Protocol/ops：
#   sudo env SITE_NAME=十堰 \
#     SP_ADMIN_TOKEN_RO="$(openssl rand -hex 32)" \
#     MON_CAPACITY=325 \
#     MON_NGINX_LOG=/var/log/nginx/sp.rainya.me.access.log \
#     MON_IFACE=eth0 \
#     [MON_DISK_DEV=vda1] [MON_CERT_FILE=/etc/letsencrypt/live/<域名>/fullchain.pem] \
#     /opt/stronghold-ops/deploy/install-agent.sh
#
# 已有 /etc/stronghold/{monitor,admin}.env 时默认保留，FORCE=1 覆盖。
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "✗ 请用 sudo / root 运行"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "✗ 未找到 node"; exit 1; }
[[ $(node -p 'Number(process.versions.node.split(".")[0])') -ge 22 ]] || { echo "✗ 需要 Node.js >= 22（当前 $(node -v)）"; exit 1; }

# 这些值会被写入 /etc/stronghold/*.env，必须不能换行（防止注入额外 env 行）。
for name in SITE_NAME SP_ADMIN_TOKEN_RO SP_ADMIN_TOKEN_RW MON_ANNOUNCEMENT_FILE MON_NGINX_LOG MON_IFACE MON_HEALTHZ MON_DATA_DIR MON_TIME_ZONE MON_ANNOUNCEMENT_URL MON_DISK_DEV; do
  eval "value=\${$name:-}"
  case $value in *$'\n'*|*$'\r'*) echo "✗ $name 不能包含换行符"; exit 1;; esac
done

SITE_NAME=${SITE_NAME:-$(hostname)}
APP_DIR=${APP_DIR:-/opt/stronghold-ops}
MON_CAPACITY=${MON_CAPACITY:-200}
MON_IFACE=${MON_IFACE:-eth0}
MON_HEALTHZ=${MON_HEALTHZ:-http://127.0.0.1:3000/healthz}
MON_DATA_DIR=${MON_DATA_DIR:-/var/lib/stronghold-monitor}
MON_TIME_ZONE=${MON_TIME_ZONE:-Asia/Shanghai}
MON_ANNOUNCEMENT_URL=${MON_ANNOUNCEMENT_URL:-http://127.0.0.1:3000/api/announcement}
MON_AGENT_INTERVAL_MS=${MON_AGENT_INTERVAL_MS:-10000}
MON_ANNOUNCEMENT_FILE=${MON_ANNOUNCEMENT_FILE:-/var/lib/stronghold-announcement/announcement.json}

[[ -f $APP_DIR/collector.mjs && -f $APP_DIR/agent.mjs && -d $APP_DIR/lib ]] || {
  echo "✗ $APP_DIR 下没有 collector.mjs / agent.mjs / lib/，请先解压部署包"; exit 1; }

if [[ -f /etc/stronghold/admin.env && ${FORCE:-0} != 1 ]]; then
  [[ -f /etc/stronghold/monitor.env ]] || { echo "✗ monitor.env 缺失，请补齐配置或 FORCE=1 重建"; exit 1; }
  echo "== /etc/stronghold 已有配置，保留（FORCE=1 可覆盖）"
  # Parse as data, never source an env file as shell code. Use the preserved paths and token.
  saved_configuration=$(node -e 'const fs=require("node:fs"),{parseEnv}=require("node:util"); const m=parseEnv(fs.readFileSync("/etc/stronghold/monitor.env","utf8")),a=parseEnv(fs.readFileSync("/etc/stronghold/admin.env","utf8")); for(const v of [m.MON_DATA_DIR||"/opt/stronghold-monitor/data",m.MON_NGINX_LOG||"/var/log/nginx/game.rainya.me.access.log",a.SP_ADMIN_TOKEN_RO||"",a.SP_ADMIN_TOKEN_RW||"",a.MON_ANNOUNCEMENT_FILE||"/var/lib/stronghold-announcement/announcement.json"]) { if(/[\r\n]/.test(v)) process.exit(1); console.log(v); }')
  mapfile -t saved_values <<< "$saved_configuration"
  MON_DATA_DIR=${saved_values[0]}; MON_NGINX_LOG=${saved_values[1]}; SP_ADMIN_TOKEN_RO=${saved_values[2]:-}
  SP_ADMIN_TOKEN_RW=${saved_values[3]:-}; MON_ANNOUNCEMENT_FILE=${saved_values[4]}
  unset saved_configuration saved_values
else
  : "${SP_ADMIN_TOKEN_RO:?缺少 SP_ADMIN_TOKEN_RO（openssl rand -hex 32；同一个值要写入中间页 portal.env 的 SP_SITE_*_TOKEN_RO）}"
  : "${MON_NGINX_LOG:?缺少 MON_NGINX_LOG（本站 nginx 访问日志路径）}"
  [[ ${#SP_ADMIN_TOKEN_RO} -ge 32 ]] || { echo "✗ 令牌太短：至少 32 字符"; exit 1; }
  mkdir -p /etc/stronghold
  {
    cat > /etc/stronghold/monitor.env <<EOF
# ${SITE_NAME} · 采集器（本机回环，只读）
MON_BIND=127.0.0.1
MON_PORT=3999
MON_HEALTHZ=${MON_HEALTHZ}
MON_DATA_DIR=${MON_DATA_DIR}
MON_NGINX_LOG=${MON_NGINX_LOG}
MON_IFACE=${MON_IFACE}
MON_CAPACITY=${MON_CAPACITY}
MON_TIME_ZONE=${MON_TIME_ZONE}
EOF
    [[ -n ${MON_DISK_DEV:-} ]] && echo "MON_DISK_DEV=${MON_DISK_DEV}" >> /etc/stronghold/monitor.env
    true
  }
  cat > /etc/stronghold/admin.env <<EOF
# ${SITE_NAME} · 管理 Agent（本机回环，中间页面板经 nginx 反代轮询）
SP_ADMIN_TOKEN_RO=${SP_ADMIN_TOKEN_RO}
MON_COLLECTOR_URL=http://127.0.0.1:3999/api/data
MON_ANNOUNCEMENT_URL=${MON_ANNOUNCEMENT_URL}
SP_ADMIN_PORT=3900
MON_AGENT_INTERVAL_MS=${MON_AGENT_INTERVAL_MS}
EOF
  if [[ -n ${MON_CERT_FILE:-} ]]; then echo "MON_CERT_FILE=${MON_CERT_FILE}" >> /etc/stronghold/admin.env; fi
  chmod 600 /etc/stronghold/monitor.env /etc/stronghold/admin.env
  echo "== 已写入 /etc/stronghold/{monitor,admin}.env"
fi

# A separate management key permits only announcement writes; existing RO keys remain read-only.
SP_ADMIN_TOKEN_RW=${SP_ADMIN_TOKEN_RW:-$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')}
[[ ${#SP_ADMIN_TOKEN_RW} -ge 32 && $SP_ADMIN_TOKEN_RW != "$SP_ADMIN_TOKEN_RO" ]] || { echo "✗ 管理密钥至少 32 字符且必须与只读密钥不同"; exit 1; }
[[ $MON_ANNOUNCEMENT_FILE =~ ^/[a-zA-Z0-9._/-]+/announcement\.json$ ]] || { echo "✗ MON_ANNOUNCEMENT_FILE 必须是独立目录下的 announcement.json 绝对路径"; exit 1; }
MON_ANNOUNCEMENT_FILE=$(realpath -m -- "$MON_ANNOUNCEMENT_FILE")
announcement_dir=$(dirname -- "$MON_ANNOUNCEMENT_FILE")
case $announcement_dir in /var/lib/*) ;; *) echo "✗ 公告写入目录必须是 /var/lib 下的独立目录"; exit 1;; esac
[[ $announcement_dir != "$MON_DATA_DIR" ]] || { echo "✗ 公告目录不能与监控存储混用"; exit 1; }
# Save configuration as data; never execute its contents or print credentials.
export SP_ADMIN_TOKEN_RW MON_ANNOUNCEMENT_FILE
node --input-type=module -e 'import fs from "node:fs"; import {parseEnv} from "node:util";
const file="/etc/stronghold/admin.env", text=fs.readFileSync(file,"utf8"), saved=parseEnv(text);
const additions=Object.entries({SP_ADMIN_TOKEN_RW:process.env.SP_ADMIN_TOKEN_RW,MON_ANNOUNCEMENT_FILE:process.env.MON_ANNOUNCEMENT_FILE}).filter(([key,value])=>saved[key]!==value);
if(additions.length){const keys=new Set(additions.map(([key])=>key)); const kept=text.split(/\r?\n/).filter(line=>!keys.has(line.match(/^([A-Z_]+)=/)?.[1])).join("\n");
const tmp=file+".tmp"; fs.writeFileSync(tmp,kept.replace(/\n*$/, "\n")+additions.map(([key,value])=>key+"="+JSON.stringify(value)).join("\n")+"\n",{mode:0o600});fs.renameSync(tmp,file);}'

# Only a dedicated absolute data directory is accepted in the generated systemd unit.
[[ $MON_DATA_DIR =~ ^/[a-zA-Z0-9._/-]+$ ]] || { echo "✗ MON_DATA_DIR 必须是无空格的绝对路径"; exit 1; }
MON_DATA_DIR=$(realpath -m -- "$MON_DATA_DIR")
case $MON_DATA_DIR in /|/var|/var/lib|/etc|/opt|/usr|/home|/root|/tmp|/tmp/*|/var/tmp|/var/tmp/*) echo "✗ MON_DATA_DIR 必须是独立持久目录"; exit 1;; esac
[[ ${#SP_ADMIN_TOKEN_RO} -ge 32 ]] || { echo "✗ 已保存的令牌太短或缺失"; exit 1; }
getent passwd spmonitor >/dev/null || useradd -r -s /usr/sbin/nologin spmonitor
install -d -m 0750 -o spmonitor -g spmonitor -- "$MON_DATA_DIR"
install -d -m 0755 -o spmonitor -g spmonitor -- "$announcement_dir"
# Diagnose access without opening every nginx log to the probe user.
if ! runuser -u spmonitor -- test -r "$MON_NGINX_LOG"; then
  echo "△ spmonitor 无法读取访问日志：$MON_NGINX_LOG；请检查路径并配置该日志的只读 ACL（含 logrotate 后权限）"
fi

cat > /etc/systemd/system/sp-collector.service <<EOF
[Unit]
Description=Stronghold API-only metrics collector
After=network.target

[Service]
Type=simple
User=spmonitor
Group=spmonitor
WorkingDirectory=${APP_DIR}
EnvironmentFile=/etc/stronghold/monitor.env
StateDirectory=stronghold-monitor
ExecStart=/usr/bin/node ${APP_DIR}/collector.mjs
Restart=on-failure
RestartSec=5
# 探针让路给游戏：后台调度 + 硬性 CPU 上限（单核 10%）+ 空闲 IO 优先级 + 内存护栏。
# 常态占用远低于该上限；超限只会拖慢探针自身采样，不会挤占游戏进程。
Nice=10
CPUSchedulingPolicy=batch
IOSchedulingClass=idle
CPUQuota=10%
MemoryHigh=200M
MemoryMax=512M
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${MON_DATA_DIR}
ProtectHome=true
UMask=0077

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/sp-admin.service <<EOF
[Unit]
Description=Stronghold monitoring and announcement Agent
After=network.target

[Service]
Type=simple
User=spmonitor
Group=spmonitor
WorkingDirectory=${APP_DIR}
EnvironmentFile=/etc/stronghold/admin.env
ExecStart=/usr/bin/node ${APP_DIR}/agent.mjs
Restart=on-failure
RestartSec=5
# 探针让路给游戏：后台调度 + 硬性 CPU 上限（单核 10%）+ 内存护栏。
Nice=10
CPUSchedulingPolicy=batch
CPUQuota=10%
MemoryHigh=150M
MemoryMax=384M
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${announcement_dir}
ProtectHome=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
UMask=0077

[Install]
WantedBy=multi-user.target
EOF

mkdir -p /etc/nginx/snippets
cat > /etc/nginx/snippets/stronghold-ops.conf <<'EOF'
# 本站管理路由（探针监控与公告 API）。合并进本站现有 HTTPS server 块：
#   在 server { } 里加一行：  include snippets/stronghold-ops.conf;
# 不要在本站暴露 3900 端口，也不要添加 Access-Control-Allow-Origin。
location ^~ /api/admin/v1/ {
    auth_basic off;
    client_max_body_size 16k;
    proxy_pass http://127.0.0.1:3900;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_connect_timeout 3s;
    proxy_read_timeout 10s;
    proxy_cache off;
    proxy_hide_header Access-Control-Allow-Origin;
    add_header Cache-Control "no-store" always;
    add_header X-Robots-Tag "noindex, nofollow" always;
}
location ^~ /internal/admin/ { return 404; }
EOF

systemctl daemon-reload
systemctl enable sp-collector sp-admin
# restart 而非 start：重复安装/改配置后也能让新 env 生效
systemctl restart sp-collector sp-admin
sleep 1

echo "== 本机自检"
curl -fsS http://127.0.0.1:3999/api/health >/dev/null && echo "✓ collector  3999 ok"
curl -fsS -H "Authorization: Bearer ${SP_ADMIN_TOKEN_RO}" http://127.0.0.1:3900/api/admin/v1/health >/dev/null \
  && echo "✓ agent      3900 可达（采样就绪与日志/落盘状态请查看 overview）"

if [[ -n ${CENTRAL_HEALTH:-} ]]; then
  curl -fsS "$CENTRAL_HEALTH" >/dev/null 2>&1 && echo "✓ 中间页可达：${CENTRAL_HEALTH}" ||
    echo "△ 中间页暂不可达（${CENTRAL_HEALTH}），可稍后手动验证"
fi

cat <<'NEXT'

== 剩余手工步骤 ==
1) 在本站 HTTPS server 块加入：  include snippets/stronghold-ops.conf;
   然后：  nginx -t && systemctl reload nginx
2) 查看 /etc/stronghold/admin.env 的 SP_ADMIN_TOKEN_RW，在面板站点配置的探针密钥框填写它。
   旧 SP_ADMIN_TOKEN_RO 仍可读监控，但不能发布公告。
   回中间页验证（把 <令牌> 换成本站 SP_ADMIN_TOKEN_RW）：
   curl -s -H "Authorization: Bearer <令牌>" https://<本站域名>/api/admin/v1/overview | head -c 300
3) 游戏更新到支持 agent 模式的版本，移除旧 SP_ANNOUNCEMENT_URL / SOURCE=panel，
   或设置游戏环境 SP_ANNOUNCEMENT_SOURCE=agent 后重启游戏。自定义文件路径时同时设置
   SP_ANNOUNCEMENT_AGENT_FILE；Docker 将公告目录只读挂载至容器同一路径。
4) 在 /ops/manage.html 发布公告，检查「已写入探针」和线上生效状态。
NEXT
