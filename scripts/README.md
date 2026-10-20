# 启动与部署脚本

从仓库根目录运行脚本；完整流程统一见[部署指南](../custom_docs/operations/DEPLOY.md)，Windows 自启见[家用开服](../custom_docs/operations/HOME_SERVER.md)，公告来源见[公告接入](../custom_docs/operations/ANNOUNCEMENTS.md)。

| 文件 | 用途 |
|---|---|
| `start-windows.bat`、`start-windows.ps1` | Windows 启动入口 |
| `start.sh` | macOS / Linux 启动入口 |
| `launch.mjs`、`open-browser.mjs` | 启动检查和打开浏览器 |
| `deploy-compose.mjs` | 生成 docker compose 部署用的环境文件（见[部署指南](../custom_docs/operations/DEPLOY.md)） |
| `install-service-windows.ps1`、`run-server.cmd` | Windows 开机自启和服务启动；本机生成的 `service.env.cmd` 不入库 |
| `make-windows-bundle.mjs` | 制作 Windows 便携包；见[Windows 说明](../docs/WINDOWS.md) |
| `network-probe.ps1` | 本地网络与 WebSocket 诊断 |
| `nginx-log-format.conf.example`、`nginx-game-cache.conf.example` | `nginx.conf.example` 引用的两个配置片段；分别安装为 `/etc/nginx/conf.d/sp-log-format.conf` 与 `/etc/nginx/snippets/stronghold-game-cache.conf` |
| `nginx.conf.example` | Nginx 反向代理配置示例 |
| `hardening/browser-gate/` | 独立自动浏览器工作量证明准入服务；配合 Nginx gate 片段，见[入口验证](../custom_docs/operations/BROWSER_GATE.md) |
| `hardening/` | GeoLite 国内准入与 nft 渲染器、健康接口 5 秒缓存、API 关闭映射、fail2ban、sysctl、日志轮转与每日完整性巡检；见[主机加固](../custom_docs/operations/HOST_HARDENING.md) |
| `hardening/sp-ws-upgrade.filter.conf`、`hardening/sp-hardening.jail.conf` | 只累计 `/ws` 444 升级拒绝，60 秒 100 次封禁 1 小时；成功连接不计；见[WS 防护](../custom_docs/operations/WS_PROTECTION.md) |
| `hardening/sp-page-global.conf` | 所有来源共用的主页 30 次/秒、burst 60 入口预算，在浏览器认证之前拒绝洪泛；见[HTTP 防护](../custom_docs/operations/HTTP_PROTECTION.md) |
| `hardening/sp-web-syn-guard.nft.example` | 直连 Web 新 SYN 限速，独立于 SSH 和已有连接；应用前核对实际内网端口、国家链优先级并做隔离测试 |
| `r2-cors.example.json` | R2 跨域配置示例；见[CDN 说明](../custom_docs/operations/CDN.md) |

数据生成、素材下载和诊断工具在 [`tools/`](../tools/README.md)。临时脚本与执行日志放入 `.cache/`。

当前额度、共享 IP 风险、推荐覆盖和逐机验收统一见 [部署限额](../custom_docs/operations/LIMITS.md)，问题处理顺序见 [三机问题方案](../custom_docs/operations/FLEET_PROBLEMS_2026-10-19.md)。事故记录只表示当时现场值，不能用作当前配置表。修改前核对 Nginx、Node、面板与已启用 jail；静态预算只装在游戏源站，CDN 素材不限制次数。
