# 启动与部署脚本

从仓库根目录运行脚本；完整流程见[部署指南](../docs/operations/DEPLOY.md)。

| 文件 | 用途 |
|---|---|
| `start-windows.bat`、`start-windows.ps1` | Windows 启动入口 |
| `start.sh` | macOS / Linux 启动入口 |
| `launch.mjs`、`open-browser.mjs` | 启动检查和打开浏览器 |
| `install-service-windows.ps1`、`run-server.cmd` | Windows 开机自启和服务启动；本机生成的 `service.env.cmd` 不入库 |
| `make-windows-bundle.mjs` | 制作 Windows 便携包；见[Windows 说明](../docs/operations/WINDOWS.md) |
| `nginx.conf.example` | Nginx 反向代理配置示例 |
| `r2-cors.example.json` | R2 跨域配置示例；见[CDN 说明](../docs/operations/CDN.md) |

数据生成、素材下载和诊断工具在 [`tools/`](../tools/README.md)。临时脚本与执行日志放入 `.cache/`。
