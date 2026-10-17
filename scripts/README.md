# 启动与部署脚本

从仓库根目录运行脚本；完整流程统一见[部署指南](../custom_docs/operations/DEPLOY.md)，Windows 自启见[家用开服](../custom_docs/operations/HOME_SERVER.md)，公告来源见[公告接入](../custom_docs/operations/ANNOUNCEMENTS.md)。

| 文件 | 用途 |
|---|---|
| `start-windows.bat`、`start-windows.ps1` | Windows 启动入口 |
| `start.sh` | macOS / Linux 启动入口 |
| `launch.mjs`、`open-browser.mjs` | 启动检查和打开浏览器 |
| `install-service-windows.ps1`、`run-server.cmd` | Windows 开机自启和服务启动；本机生成的 `service.env.cmd` 不入库 |
| `make-windows-bundle.mjs` | 制作 Windows 便携包；见[Windows 说明](../docs/WINDOWS.md) |
| `network-probe.ps1` | 本地网络与 WebSocket 诊断 |
| `nginx-log-format.conf.example`、`nginx-game-cache.conf.example` | `nginx.conf.example` 引用的两个配置片段；分别安装为 `/etc/nginx/conf.d/sp-log-format.conf` 与 `/etc/nginx/snippets/stronghold-game-cache.conf` |
| `nginx.conf.example` | Nginx 反向代理配置示例 |
| `hardening/browser-gate/` | 独立自动浏览器工作量证明准入服务；配合 Nginx gate 片段，见[入口验证](../custom_docs/operations/BROWSER_GATE.md) |
| `hardening/` | GeoLite 国内准入与 nft 渲染器、健康接口 5 秒缓存、API 关闭映射、fail2ban、sysctl、日志轮转与每日完整性巡检；见[主机加固](../custom_docs/operations/HOST_HARDENING.md) |
| `hardening/sp-ws-upgrade.filter.conf`、`hardening/sp-hardening.jail.conf` | 只累计 `/ws` 444 升级拒绝，60 秒 100 次封禁 1 小时；成功连接不计；见[WS 防护](../custom_docs/operations/WS_PROTECTION.md) |
| `hardening/sp-page-global.conf` | 所有来源共用的主页 20 次/秒入口预算，在浏览器认证之前拒绝洪泛；见[HTTP 防护](../custom_docs/operations/HTTP_PROTECTION.md) |
| `hardening/sp-web-syn-guard.nft.example` | 直连 Web 新 SYN 限速，独立于 SSH 和已有连接；应用前核对实际内网端口、国家链优先级并做隔离测试 |
| `r2-cors.example.json` | R2 跨域配置示例；见[CDN 说明](../custom_docs/operations/CDN.md) |

数据生成、素材下载和诊断工具在 [`tools/`](../tools/README.md)。临时脚本与执行日志放入 `.cache/`。

2026-10-17 的默认值调整与 CDN 不限次数边界见 [事故记录](../custom_docs/operations/INCIDENT-2026-10-17.md)：Nginx 每 worker 16384 连接、源站总并发 3000、WS 总并发 800；修改配置前检查服务的文件描述符限制。门户 ping 30/min（burst 10、免浏览器 Cookie），房间查询 20/min（burst 5、保留准入）。静态预算只应用在游戏源站，不能把同一套次数限制装到素材 CDN。
