# 国内站使用香港站的 Cloudflare 素材缓存

香港站入口为 `https://game.misyra.com/play`；素材在 `https://game.misyra.com/assets/` 和 `/fonts/`，所以 CDN 基地址是 **`https://game.misyra.com`，不含 `/play`**。国内站保留现有 DNS、页面、代码、游戏数据、API 和 WebSocket，图片、Spine、音频、字体使用香港域名。主动资源预载尚未接入；后续预载应复用同一批素材 URL。

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
