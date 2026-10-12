# 监控探针与管理面板

游戏部署从 [DEPLOY.md](DEPLOY.md) 开始；公告接入统一看 [ANNOUNCEMENTS.md](ANNOUNCEMENTS.md)。

## 三个服务的分工

| 服务 | 位置 | 作用 |
|---|---|---|
| 游戏 Node | 各游戏服，通常 3000 | 对局、WebSocket、游戏公告只读出口 |
| collector + Agent | 各游戏服，回环 3999 / 3900 | 本机采集、监控 API 和限定公告写入 |
| sp-portal | 中央服务器，通常回环 4200 | 联机入口、`/ops/` 管理面板、公告 feed 和中央历史库 |

探针代码**不随本仓库分发**：它属于 sp-portal 项目，那边由 `deploy/sync-agent.mjs` 生成为仓库内的 `ops/` 产物树（`npm test` 里有一条用例守着它没变旧），部署时把整份 `ops/` 拷到游戏服，或用 `npm run pack:agent` 出的 zip。本仓库曾经也有一份 `ops/`、靠单向脚本覆盖，结果是同一份代码存在两处，还发生过反向开发（有人在这里那份的 `lib/game-diagnostics.mjs` 上加了诊断却没回灌），2026-10-12 起取消。产物树里的 `DEPLOYMENT.md`、`HISTORY.md`、`PAGE_POLICY.md` 是随探针一起发出去的快照文档，不是本游戏的另一套部署入口；中央服务部署以 sp-portal 当前文档和模板为准，旧 `sp-monitor` 仅作历史参考。

## 游戏服首次安装探针

游戏已经运行，准备本站独立只读令牌；脚本另生成管理密钥用于面板监控与公告发布。路径和日志名按实际服务器修改：

```bash
# 先把 sp-portal 仓库的 ops/ 产物树拷到本站（刻意不放在游戏仓库里，见上一节）：
#   在 sp-portal 目录：rsync -a --delete ops/ <游戏服>:/opt/stronghold-ops/
sudo env APP_DIR=/opt/stronghold-ops SITE_NAME=西安 \
  SP_ADMIN_TOKEN_RO="$(openssl rand -hex 32)" \
  MON_CAPACITY=200 MON_IFACE=eth0 \
  MON_NGINX_LOG=/var/log/nginx/game.access.log \
  /opt/stronghold-ops/deploy/install-agent.sh
```

脚本创建 `/etc/stronghold/monitor.env`、`admin.env`、数据目录及 `sp-collector` / `sp-admin` 单元，已有环境文件默认保留，升级时自动补充独立管理密钥和公告目录写权限。按脚本输出将生成的 nginx 片段 include 到本站 HTTPS server 块，`nginx -t` 通过后 reload。不要直接对公网开放 3999 / 3900。

面板站点配置中填写实际 Agent HTTPS URL 和 admin.env 中的 SP_ADMIN_TOKEN_RW 管理密钥，先测试连接再保存。密钥只保存在服务端，不放 Git 或公开文档。访问日志需要给 `spmonitor` 只读权限，日志轮转后仍须可读；自定义数据目录须与 unit 的可写目录一致。

旧 SP_ADMIN_TOKEN_RO 仍仅监控。公告由面板写入独立的 /var/lib/stronghold-announcement/announcement.json，游戏默认热读取；升级已有游戏的来源切换见 [ANNOUNCEMENTS.md](ANNOUNCEMENTS.md)。

## 更新与验证

```bash
# 代码已按游戏部署流程拉取后；首次升级写公告能力时先重新运行安装脚本
sudo systemctl restart sp-collector sp-admin
curl -s http://127.0.0.1:3999/api/health
```

探针的更新不跟游戏代码走：在 sp-portal 目录重新生成 `ops/`（`npm run sync:agent`，`npm run check:agent` 校验），整份覆盖到服务器上那份目录（`rsync -a --delete ops/ <游戏服>:/opt/stronghold-ops/`，或解压新的 `sp-ops-agent.zip`），再重启两个 unit。游戏进程、探针和中央面板分别重启；重启探针不会自动重启游戏。面板显示的探针版本应与服务器上那份 `ops/VERSION` 一致；采集与日志、落盘诊断应正常。日志用 `journalctl -u sp-collector -u sp-admin` 查看。

Agent 默认从 `http://127.0.0.1:3000/api/announcement` 读取游戏当前公告；游戏端口变化时修改 `admin.env` 的 `MON_ANNOUNCEMENT_URL`。这是监控读取地址，**不是**游戏的中央公告源配置。

## 历史与备份

中央历史库在 sp-portal 的 `PANEL_HISTORY_FILE`，游戏服有限补传缓存在 `MON_DATA_DIR`。前者使用 SQLite 一致性备份，后者保留周期由 `MON_RETAIN_DAYS` 控制；历史契约见探针产物树里的 `HISTORY.md`（随探针一起拷到服务器上那份目录，见上文）。游戏对局的 `.state/` 是另一套数据，备份方法见 [PERSISTENCE.md](PERSISTENCE.md)。
