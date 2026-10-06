# 国内站使用香港站的 Cloudflare 素材缓存

香港站入口为 `https://game.misyra.com/play`；素材在 `https://game.misyra.com/assets/` 和 `/fonts/`，所以 CDN 基地址是 **`https://game.misyra.com`，不含 `/play`**。国内站保留现有 DNS、页面、代码、游戏数据、API 和 WebSocket，图片、Spine、音频、字体使用香港域名。浏览器预载已接入并复用这些素材 URL，使用方法见第 5 节。

## 1. 先配置香港站的跨域响应

2026-10-05 实测：图片、Spine 骨骼 / atlas、音频和字体均可访问，并有 `CF-Cache-Status: MISS`，但带 `Origin` 请求仍未返回 `Access-Control-Allow-Origin`。因此目前国内网页还不能直接跨域加载这些素材。

香港站更新本次代码并重启后，Node 会给公开的 `/assets/`、`/fonts/`、`/media/` 和对应版本路径添加 `Access-Control-Allow-Origin: *`，支持 GET / HEAD、Range 和 OPTIONS。这些素材不带凭据；API、游戏数据、脚本及 WebSocket 不开放跨域。

如果 nginx 直接提供素材，请求没有经过 Node，则需要在**现有素材 location 内**添加 [跨域配置示例](../scripts/nginx.assets-cors.conf.example)，保留原来的 `root` / `alias` / `proxy_pass` 与缓存规则。不要把该片段放到整个网站的 `location /`。若请求已转给新版 Node，不要再添加一份同名 CORS 响应头。

nginx 配置修改后先 `nginx -t`，通过后 reload。然后清理 Cloudflare 中这些素材的已有缓存，让新跨域响应头生效。[Cloudflare CORS 缓存说明](https://developers.cloudflare.com/r2/buckets/cors/#use-cors-with-a-custom-domain)

可用下面的命令验证（将 Origin 替换为国内站的真实 origin）：

```bash
curl -I -H 'Origin: https://你的国内站域名' https://game.misyra.com/assets/char/avatar/char_1012_skadi2.png
curl -I -H 'Origin: https://你的国内站域名' https://game.misyra.com/fonts/bender-regular.woff2
```

响应应包含 `Access-Control-Allow-Origin: *`。同一个请求再次到达边缘缓存时，可检查 `CF-Cache-Status: HIT`；浏览器自身缓存命中时不会重新请求 Cloudflare。

2026-10-05 本地实测：游戏运行于 `http://localhost:3001`，CDN 指向真实香港域名，通过当前终端代理访问。香港 `/healthz` 仍报告 0.1.2、没有 `artVersion`；头像、Spine 骨骼和字体返回 HTTP 200、`server: cloudflare`，但没有跨域许可头，Edge 直接跨域 fetch 全部被 CORS 拦截。仅在本地测试浏览器中模拟添加素材的 `Access-Control-Allow-Origin: *`，使用真实 CF 返回的文件内容，6 个抽样文件（头像、骨骼、atlas、字体、字体 CSS、音频）全部预载成功；随后断网仍从 Service Worker 读到这 6 个文件。头像、骨骼和字体出现 `CF-Cache-Status: HIT`。该模拟没有修改香港站，也不代表线上跨域已经可用；当前仍需完成本节的香港站配置。这是代理环境下的兼容性检查，不是国内网络延迟测试。

## 2. 国内站启用 CDN

国内站更新本次代码，在启动进程的环境变量中设置：

```powershell
$env:SP_ASSETS_CDN = 'https://game.misyra.com'
# 兼容当前香港站的普通资源路径：不要使用国内站的素材版本号。
Remove-Item Env:SP_ASSETS_CDN_VERSION -ErrorAction SilentlyContinue
npm start
```

Linux / macOS：

```bash
SP_ASSETS_CDN=https://game.misyra.com npm start
```

若使用服务管理器，写入该服务的环境配置并重启；当前服务器不会自动读取根目录 `.env`。香港站自身不需要设置 `SP_ASSETS_CDN`。不设置或清空此变量时，保持本站素材加载。

这个兼容模式使用 `https://game.misyra.com/assets/…` 的普通路径，遵循香港站自己的缓存时长。更新同名素材后，需要清理 Cloudflare 对应缓存；两站的素材清单与文件应保持同一发布版本。浏览器中刷新国内页面后，检查素材请求指向香港站，而 `/data/`、`/js/`、`/api/`、`/ws` 仍指向国内站。

## 3. 两站更新后使用版本资源

香港站部署本次版本缓存代码后，`https://game.misyra.com/healthz` 会包含 `artVersion`。在国内站额外设置该**香港站**版本号：

```powershell
$env:SP_ASSETS_CDN = 'https://game.misyra.com'
$env:SP_ASSETS_CDN_VERSION = '<香港站 healthz 的 artVersion，16 位小写十六进制>'
npm start
```

素材 URL 将变为 `https://game.misyra.com/_v/<香港素材版本>/assets/…`，有版本的资源缓存一年。两站本地文件修改时间不同，版本号可能不同；代码不会把国内版本号直接拼到香港域名。Spine 的 atlas 与纹理继续使用骨骼旁边的相对路径。修改 CDN 基地址 / 版本号会更新国内页面的发布版本，旧页面沿用已有更新提示。

香港站素材更新时，先更新香港站并取得新的 `artVersion`，再更新国内站配置与同版素材清单并重启。当前 Node 只提供正在运行的素材版本，旧路径在 Cloudflare 未命中时会返回 404；因此两站切换需配合进行，不能保证旧页面永久访问旧素材。

## 4. Cloudflare 缓存规则

确认 `game.misyra.com` 是橙云代理。添加 Cache Rule，限制为香港站的普通素材或带版本素材：

```text
(http.host eq "game.misyra.com" and (
  starts_with(http.request.uri.path, "/assets/") or
  starts_with(http.request.uri.path, "/fonts/") or
  (starts_with(http.request.uri.path, "/_v/") and (
    http.request.uri.path contains "/assets/" or
    http.request.uri.path contains "/fonts/"
  ))
))
```

设置 **Eligible for cache**，Edge TTL 与 Browser TTL 尊重源站 `Cache-Control`，不要强制缓存源站的 `no-store` 错误响应。这样 `.skel`、`.atlas`、`.obj`、棋盘 JSON 等也能缓存；`/play`、API、健康检查和游戏连接不在此规则内。[Cloudflare Cache Rules](https://developers.cloudflare.com/cache/how-to/cache-rules/)

`/healthz` 同时报告当前站的 `artVersion`、配置的 `assetsCdn` 与 `assetsCdnVersion`，用于核对部署。CDN 不可用时没有自动切换整套素材的回退：可清空 `SP_ASSETS_CDN` 与 `SP_ASSETS_CDN_VERSION`，重启国内站，恢复本站加载；不要让单个 Spine 骨骼和纹理来自不同版本。

## 5. 浏览器预载

首页右下角或对局设置中的「预载资源」可开启预载，默认关闭。优先下载字体、界面、图标、音频，再下载立绘、Spine 和棋盘素材；显示文件及大小进度，支持暂停、继续、清理缓存。关闭预载停止下载并保留已保存的素材。需要 HTTPS 或 localhost。

清单由 `/data/resource-manifest.json` 动态生成，沿用游戏的 CDN 配置和资源版本。Service Worker 只读取素材缓存；游戏仍需要服务器连接。内容未改变的二进制素材会跨版本路径复用，CSS/JSON 因可能被服务器重写而重新校验版本。单文件限制 24 MiB，已知超大文件跳过；空间不足会停止，并保留已有进度。另一标签页预载期间不能清理共享缓存，请先暂停该标签页。

反向代理需将 `/resource-sw.js`、`/js/resources/` 和 `/data/resource-manifest.json` 路由至此版本的 Node 服务；清单和 Worker 脚本应遵循源站的 `no-cache`，不要套用素材一年缓存规则。

本地已有文件在首次读取清单时补算内容指纹，不增加启动时的素材读取。也可在部署前运行 `node tools/asset-hashes.mjs`，生成本机 `data/asset-hashes.json`（不提交 Git）；用 `node tools/asset-hashes.mjs --check` 检查。素材改变后重生成指纹并重启。只有 CDN、没有本地文件或指纹时，使用清单版本回退，不能保证每文件增量。CDN 两次返回与内容指纹不符的文件不会标记为完成，请同步两站素材并清理旧 CDN 缓存。

预载实现移植并改编自 [xinhai-ai/Stronghold-Protocol](https://github.com/xinhai-ai/Stronghold-Protocol)，保留 GPL-3.0-or-later 许可，并增加本站版本资源与 CDN 的适配。

## 6. 用 Cloudflare R2 作为素材 CDN

R2 方案不再需要一个常驻的香港站 Node 源站：素材对象直接放在 R2 bucket 里，由绑定的自定义域名（走 Cloudflare 边缘缓存）对外服务。管理操作全部可用 Wrangler CLI 完成（上传走 [S3 兼容 API](https://developers.cloudflare.com/r2/api/s3/api/) 的批量脚本，见下）。

一次性准备：

```powershell
npx wrangler login
npx wrangler r2 bucket create <bucket>
# 自定义域名需域名已托管在 Cloudflare；一个域名只能绑定一个 bucket
npx wrangler r2 bucket domain add <bucket> --domain assets.example.com --zone-id <zone_id>
# CORS：Spine / 音频是跨域 fetch，必须放行 GET / HEAD
npx wrangler r2 bucket cors set <bucket> --file scripts/r2-cors.example.json
```

上传与发布（`tools/r2-sync.mjs`）：

```powershell
node tools/r2-sync.mjs --bucket <bucket>            # 上传 public/{assets,fonts,media}
node tools/r2-sync.mjs --bucket <bucket> --dry-run  # 只看将要上传的内容
```

脚本的行为：

- 每个文件写两个 key：`assets/…`（普通路径）和 `_v/<tag>/assets/…`（版本化发布）。`tag` 是全部美术文件「路径 + SHA-256 内容」哈希的前 16 位十六进制，美术不变则 tag 不变，重跑即 no-op。
- 支持断点续传（`.cache/r2-sync-progress.json`）；OAuth token 过期时自动调 `wrangler whoami` 刷新。
- 上传限速约 3 req/s 并对 429 全局退避：Cloudflare 管理 API 有每账户请求配额，并发猛打会大面积 429。
- 成功后把 tag 写入 `_v/latest`（`Cache-Control: no-store`），供服务器启动时自动解析。

服务器侧只需设置 `SP_ASSETS_CDN=https://assets.example.com`。**`SP_ASSETS_CDN_VERSION` 现在是可选项**，解析优先级为：显式设置的环境变量 → 仓库根目录的 `.assets-cdn-version`（由同步脚本写入、随发布提交）→ CDN 上的 `_v/latest` 对象（带时间戳查询参数，绕过所有缓存）→ 都没有则回退为无版本 URL，行为与第 2 节的兼容模式一致。手动设置该变量仍然生效，可用于钉住旧版本回滚。

发布新美术的完整流程：`node tools/r2-sync.mjs --bucket <bucket> --push` → 重启服务器。脚本成功后会更新 `.assets-cdn-version`；`--push` 额外把这一个文件提交（`素材：R2 发布 <tag>`）并推送 master 到除 `origin` 外的所有远程（GitHub fork 与 Gitee）。部署机 `git pull` 后重启即完成同步，版本文件优先于网络请求，启动不依赖 CDN 可达。每个 tag 都是自洽的全量快照，旧 tag 的对象永久保留，旧页面与已缓存版本不受影响。玩家端 Service Worker 按文件内容哈希跨版本复用未变化的文件（见第 5 节），只有真正变化的文件会重新下载。

费用：只有穿透到 R2 的读取（Class B）计费，边缘缓存命中不计费，流量免费；配合高命中率（建议开启 [Tiered Cache](https://developers.cloudflare.com/cache/how-to/tiered-cache/)）月请求量通常在免费额度内。

### 6.1 本站实际部署（2026-10-06）

- bucket：`weishu`；自定义域名：`https://assets.misyra.com`（zone `misyra.com`）；当前发布：`c42c1bf187c71866`（5503 个文件，约 334 MiB，双 key 共 11006 个对象）。
- `public/dev/` 不上传；`/js/`、`/vendor/`、`/data/`、`/api/`、`/ws` 留在游戏服务器，不上 R2。

**启用（游戏服务器上唯一要做的事）**：

```powershell
$env:SP_ASSETS_CDN = 'https://assets.misyra.com'
npm start        # 或写进服务管理器的环境配置
```

不设置就维持本机加载素材的现状，完全无害；设置后只有 `/assets`、`/fonts`、`/media` 走 R2。版本号不用设——仓库里的 `.assets-cdn-version` 随 `git pull` 生效；回滚旧版本时才手动设 `SP_ASSETS_CDN_VERSION` 钉住。

**重启后验收（约 30 秒）**：

1. 打开 `https://<游戏域名>/healthz`，确认 `assetsCdn` 为 `https://assets.misyra.com`、`assetsCdnVersion` 为当前 tag；启动日志同时会打出 `assets CDN … release … (from the version file)`。
2. 打开游戏页面，浏览器 Network 面板中图片 / 音频 / 字体请求应指向 `assets.misyra.com`，且 `/js/`、`/api/`、`/ws` 仍指向游戏域名。
3. 跨域抽查（应含 `Access-Control-Allow-Origin: *`，第二次请求为 `CF-Cache-Status: HIT`）：

```bash
curl -I -H 'Origin: https://<游戏域名>' https://assets.misyra.com/_v/<tag>/assets/char/avatar/char_1012_skadi2.png
```

**日常发布美术（固定三步）**：

```powershell
node tools/r2-sync.mjs --bucket weishu --push   # 增量上传 + 更新版本文件 + 提交推送
# 部署机：
git pull
重启服务器
```

**建议的一次性收尾**：Dashboard → misyra.com → Caching → Tiered Cache → 选 Smart Tiered Cache。多个边缘 PoP 未命中时先回源上层区域缓存而不是各自回源 R2，把 Class B 计费请求再压一个量级（免费额度 1000 万次/月，按当前流量命中率 92% 估算约 $3.6/月，开启后趋近 $0）。
