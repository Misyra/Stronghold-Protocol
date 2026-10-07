# 素材 CDN（Cloudflare R2）

美术（图片 / Spine / 音频 / 字体）可以放到 Cloudflare R2，由绑定的自定义域名经边缘缓存对外服务，游戏服务器不再承担素材的出网带宽与磁盘读。服务器设置一个环境变量即可启用；代码、游戏数据、API 与 WebSocket 仍由游戏服务器直出，`/js/`、`/vendor/`、`/data/`、`/api/`、`/ws` 不上 R2，`public/dev/` 不上传。

## 1. 一次性准备（Wrangler）

管理操作全部可用 Wrangler CLI 完成（上传走 [S3 兼容 API](https://developers.cloudflare.com/r2/api/s3/api/) 的批量脚本，见下）：

```powershell
npx wrangler login
npx wrangler r2 bucket create <bucket>
# 自定义域名需域名已托管在 Cloudflare；一个域名只能绑定一个 bucket
npx wrangler r2 bucket domain add <bucket> --domain assets.example.com --zone-id <zone_id>
# CORS：Spine / 音频是跨域 fetch，必须放行 GET / HEAD
npx wrangler r2 bucket cors set <bucket> --file scripts/r2-cors.example.json
```

## 2. 发布美术：tools/r2-sync.mjs（增量上传）

```powershell
node tools/r2-sync.mjs --bucket <bucket>            # 上传 public/{assets,fonts,media}
node tools/r2-sync.mjs --bucket <bucket> --dry-run  # 只看将要上传的内容
```

脚本的行为：

- 每个文件只占一个 key：普通路径 `assets/…`。仓库根目录的 `.assets-manifest.json` 记录上次发布时每个路径的内容哈希（`{ tag, hashes }`，`tag` 是全部「路径 + SHA-256 前 16 位」哈希的前 16 位十六进制，美术不变则 tag 不变）。
- 每次运行先和这份清单对比，**只上传哈希变化的文件**（通常是几个到几十个），全部成功后才重写清单；中断或失败不写清单，重跑自动补齐——清单本身就是断点续传状态，没有额外的进度文件。
- 上传限速约 3 req/s 并对 429 全局退避：Cloudflare 管理 API 有每账户请求配额，并发猛打会大面积 429。OAuth token 过期时自动调 `wrangler whoami` 刷新。
- 未知参数直接报错退出（历史上 `--help` 被静默忽略并触发过一次真实全量上传）。

发布新美术的完整流程：`node tools/r2-sync.mjs --bucket <bucket> --push` → 部署机 `git pull` → 重启服务器。`--push` 把 `.assets-manifest.json` 这一个文件提交（`素材：R2 增量发布 <tag>`）并推送 master 到除 `origin` 外的所有远程（GitHub fork 与 Gitee）。日常发布只传变化文件，通常几十秒内完成。

## 3. 游戏服务器接入

服务器侧只需设置 `SP_ASSETS_CDN=https://assets.example.com` 并保证仓库里有 `.assets-manifest.json`（随发布提交）。服务器启动时读取它，把每个美术文件的 CDN URL 改写成 `https://assets.example.com/assets/…?v=<文件哈希>`：查询串参与 CDN 缓存键，内容不变则 URL 不变（永远命中缓存），文件更新时只有它的 URL 变化。清单本身由游戏服务器在 `/assets-manifest.json?v=<tag>` 同源提供（不可变缓存，页面在 `<head>` 里就开始拉取，浏览器每个版本只下载一次）。清单不存在时回退为无版本 URL。

### 3.1 本站实际部署（2026-10-06）

- bucket：`weishu`；自定义域名：`https://assets.misyra.com`（zone `misyra.com`）。
- bucket 只维护普通路径 key，仓库以 `.assets-manifest.json` 发布（首个清单 tag 见该文件；v0.1.4 的新语音、新美术已随迁移上传，线上未切换、无感知）。

**启用（游戏服务器上唯一要做的事）**：

```powershell
$env:SP_ASSETS_CDN = 'https://assets.misyra.com'
npm start        # 或写进服务管理器的环境配置
```

不设置就维持本机加载素材的现状，完全无害；设置后只有 `/assets`、`/fonts`、`/media` 走 R2。版本号不用设——仓库里的 `.assets-manifest.json` 随 `git pull` 生效，启动日志会打出 `assets CDN … manifest … (per-file ?v= busting)`。

**重启后验收（约 30 秒）**：

1. 打开 `https://<游戏域名>/healthz`，确认 `assetsCdn` 为 `https://assets.misyra.com`、`assetsManifest` 为当前清单 tag；启动日志同时会打出 `assets CDN … manifest …`。
2. 打开游戏页面，浏览器 Network 面板中图片 / 音频 / 字体请求应指向 `assets.misyra.com` 且带 `?v=` 参数，`/assets-manifest.json?v=…` 只在首次访问下载一次；`/js/`、`/api/`、`/ws` 仍指向游戏域名。
3. 跨域抽查（应含 `Access-Control-Allow-Origin: *`，第二次请求为 `CF-Cache-Status: HIT`）：

```bash
curl -I -H 'Origin: https://<游戏域名>' "https://assets.misyra.com/assets/char/avatar/char_1012_skadi2.png?v=<healthz 清单里该文件的哈希>"
```

**日常发布美术（固定三步）**：

```powershell
node tools/r2-sync.mjs --bucket weishu --push   # 增量上传 + 更新清单 + 提交推送
# 部署机：
git pull
重启服务器
```

**建议的一次性收尾**：Dashboard → misyra.com → Caching → Tiered Cache → 选 Smart Tiered Cache。多个边缘 PoP 未命中时先回源上层区域缓存而不是各自回源 R2，把 Class B 计费请求再压一个量级（免费额度 1000 万次/月，按当前流量命中率 92% 估算约 $3.6/月，开启后趋近 $0）。费用本身只有穿透到 R2 的读取（Class B）计费，边缘缓存命中不计费，流量免费；配合高命中率月请求量通常在免费额度内。

## 4. 浏览器预载

首页右下角或对局设置中的「预载资源」可开启预载，默认关闭。优先下载字体、界面、图标、音频，再下载立绘、Spine 和棋盘素材；显示文件及大小进度，支持暂停、继续、清理缓存。关闭预载停止下载并保留已保存的素材。需要 HTTPS 或 localhost。

清单由 `/data/resource-manifest.json` 动态生成，沿用游戏的 CDN 配置和资源版本。Service Worker 只读取素材缓存；游戏仍需要服务器连接。内容未改变的二进制素材会跨版本路径复用，CSS/JSON 因可能被服务器重写而重新校验版本。单文件限制 24 MiB，已知超大文件跳过；空间不足会停止，并保留已有进度。另一标签页预载期间不能清理共享缓存，请先暂停该标签页。

反向代理需将 `/resource-sw.js`、`/js/resources/` 和 `/data/resource-manifest.json` 路由至此版本的 Node 服务；清单和 Worker 脚本应遵循源站的 `no-cache`，不要套用素材一年缓存规则。

本地已有文件在首次读取清单时补算内容指纹，不增加启动时的素材读取。也可在部署前运行 `node tools/asset-hashes.mjs`，生成本机 `data/asset-hashes.json`（不提交 Git）；用 `node tools/asset-hashes.mjs --check` 检查。素材改变后重生成指纹并重启。只有 CDN、没有本地文件或指纹时，使用清单版本回退，不能保证每文件增量。CDN 两次返回与内容指纹不符的文件不会标记为完成，请先重新发布素材（`node tools/r2-sync.mjs --bucket <bucket> --push`）再重试。

预载实现移植并改编自 [xinhai-ai/Stronghold-Protocol](https://github.com/xinhai-ai/Stronghold-Protocol)，保留 GPL-3.0-or-later 许可，并增加本站版本资源与 CDN 的适配。

## 5. 回滚

旧版「`_v/<tag>/` 全量快照」布局的对象仍保留在 bucket 里，`.assets-cdn-version` 与手动 `SP_ASSETS_CDN_VERSION` 的解析链也还在——切回旧代码即回到 `_v/<tag>/` 的版本化 URL，无需动 bucket。同步脚本不再写入这两者（旧服务器若拉到新 tag，会指向已不再生成的 `_v/` key）。
