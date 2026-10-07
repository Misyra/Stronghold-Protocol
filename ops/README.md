# 探针（collector + 只读 Agent）

本目录由 sp-portal 仓库的 deploy/sync-agent.mjs 生成，请勿手改；源码以 sp-portal 为准。
版本见 VERSION（探针文件内容哈希），面板站点卡片会显示它，用于核对各服务器是否更新到位。

首次部署：sudo env APP_DIR=<本仓库在服务器上的路径>/ops SP_ADMIN_TOKEN_RO=... .../ops/deploy/install-agent.sh（见 DEPLOYMENT.md）
日常更新：git pull && sudo systemctl restart sp-collector sp-admin
