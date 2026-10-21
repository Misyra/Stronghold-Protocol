# 部署检查清单与缓存规则

这份文件回答两个问题：**下次部署要照什么顺序做**，以及**什么东西该加缓存、什么东西加了就是坑**。
每一条都来自线上踩过的事故，括号里是踩坑时的现象，方便对号入座。

---

## 一、缓存：加什么、不加什么

### 1.1 先分清两种缓存

| | 省什么 | 决定它的是 |
|---|---|---|
| **nginx 缓存**（`proxy_cache`） | 回源成本、游戏进程 CPU | nginx 配置 |
| **客户端缓存**（浏览器 / Service Worker） | **出网带宽** | 响应头 + 前端 `fetch` 的 `cache` 选项 |

带宽高的时候改 nginx 缓存没用 —— 每个玩家还是要收一遍那堆字节。**只有客户端缓存能让字节不再出网。**

反过来也一样：客户端缓存配得再好，前端如果写 `fetch(url, { cache: 'no-cache' })`，浏览器每次都会回源确认，**任何响应头都压不过它**。

### 1.2 必加长缓存的（这些 URL 自带内容指纹，永远不会变内容）

| 路径 | 头 | 依据 |
|---|---|---|
| `/build/assets/*` | `public, max-age=31536000, immutable` | 文件名带内容哈希（`index-dWCb_fem.js`） |
| `/build/*.js` `.css` | 同上 | 同上 |
| `/_v/<runtimeTag>/...` | 同上 | 路径里就是构建指纹 |
| `/vendor/` `/js/` `/css/` `/fonts/` `/sim/` `/shared/` | 同上 | vite 产物，带哈希 |
| `/data/resource-manifest.json?v=<16位hex>` | 同上 | 带版本号就是不可变的 |
| `/assets-manifest.json?v=<tag>` | 同上 | 服务端拼的 tag |

规则：**URL 变了内容才变 → 可以 immutable 一年。** 判断标准只有一个：这个 URL 里有没有内容指纹。

### 1.3 只能短缓存或必须不缓存的

| 路径 | 头 | 为什么不能长缓存 |
|---|---|---|
| `/`、`/build/index.html`、`/play` | `no-store` 或几十秒 | 发版后必须立刻拿到新 HTML；缓存住就等于把旧 chunk 引用一直发下去，玩家看到的是旧版本且没有任何报错 |
| `/healthz` | `no-store` | 探活要真值 |
| `/api/*`、`/ws` | 不缓存 | 有状态 |
| `/_gate/*` | `no-store` | 鉴权 |
| `/data/*.json`（裸 URL，无 `?v=`） | 短（≤1h）+ `stale-while-revalidate` | 客户端会拿裸 URL，长缓存 = 发版后最多滞后这么久 |
| `/icons/` | `max-age=3600` | 文件名固定，换图标不换名 |

### 1.4 三个具体的坑

**(a) 按版本号判断的缓存头，要同时给"没版本号"兜一条。**
`map "$arg_v:$status" $sp_manifest_cc` 里 `default` 是 `no-cache`，而客户端请求的裸 URL 没有 `?v=` → 直接落到 `no-cache` → 每次导航都回源。必须显式加一条 `~^:(200|304)$ → public, max-age=<短>`。

**(b) nginx 缓存命中时不回 304。**
客户端发 `If-None-Match` 来做"确认"，nginx 从 `proxy_cache` 直接返 200 + 全量体 —— 于是"每次确认"变成"每次全量下载"。`resource-manifest.json` 是 5.95 MB（gzip 833 KB），一个玩家一次页面加载就是 833 KB。
要么让这条路径不吃 `proxy_cache`、让游戏进程自己回 304，要么在客户端层面让它根本不需要确认（见 (c)）。

**(c) 前端 `fetch` 的 `cache` 选项优先级最高。**
`cache: 'no-cache'` / `'reload'` 写在 `fetch` 的 init 里，**压过任何响应头**：服务端发 `immutable` 也没用，浏览器照样每次都问，而 nginx 缓存命中又不回 304（见 (b)）→ 每次都是全量。

规则：**URL 里带了内容指纹就用 `'default'`（走缓存），没带才用 `'no-cache'`（每次确认）。**
`public/js/resources/common.js` 的 `isVersionedManifestUrl()` 就是干这个的，`resources/index.js` 与 `resources/workerManifest.js` 已按它分流。清单 7.1 MB / gzip 3.2 MB，这一条直接决定带宽。
新写取数代码时先问一句"这个 URL 会不会同一个地址换个内容"：不会就 `'default'`。目前仍是 `'no-cache'` 且**故意如此**的：`content.js:101` 的插件目录、`data.js` 的 i18n 覆盖、`resourceNetwork.js` 的 manifest 下载（这些地址的内容会变）。

**(d) gzip 进缓存要在 key 里带 `Accept-Encoding`。**
这个响应按 `Accept-Encoding` 变体（gzip / identity），混用同一条缓存会把压缩体发给不支持的客户端。

### 1.5 实测办法

```
curl -sk -o /dev/null -D - -H "Host: <域名>" -H "Accept-Encoding: gzip" "https://127.0.0.1<路径>"
```

看四样：`HTTP` 状态、`cache-control`、`content-encoding`、`content-length`。
**别用请求数判断带宽**：按 `$body_bytes_sent` 分类汇总才有意义。`sim/content` 一度有 5 分钟 10,311 个请求，但只有 42.8 MB —— 那是连接数和 CPU 问题，不是带宽。

---

## 二、建新 release 时，哪些文件必须从线上继承

这些**不在 git 里**，`git archive` 拉不出来，`npm run build` 也不生成。漏了不会报错，会静默降级或者直接崩。

| 文件 | 漏了会怎样 |
|---|---|
| `geoip/GeoLite2-Country.mmdb` | **进程直接起不来**：`server/index.js:180` 的 `openCountryLookup` 没有 try/catch（对比 `:192-195` 的 ASN 段有），ENOENT 即退出 |
| `geoip/GeoLite2-ASN.mmdb` | 只降级不禁用（ASN 段有 try/catch），但会少一层拦截 |
| `plugins/.studio-key` | 每台不同，不能混用 |
| `data/local-assets.json`、`data/local-fx.json` | 客户端资源/特效清单变旧；这两个还进 `runtimeVersion` |
| `data/asset-hashes.json` | 资源校验层丢失 |
| `data/skins-installed.json`、`data/skins.json` | 皮肤列表空 |
| `announcement.json` | 公告空 |
| `public/fonts`（7 文件） | 字体回退 |
| `public/assets`（线上有本地美术时） | 静态图 404 |
| `ops/agent.mjs` + collector（h2/h3/h4） | `sp-admin` 的 `ExecStart` 指绝对路径，翻链接后文件不在 → 服务重启失败 |
| `.assets-manifest.json` | `/healthz` 的 `assetsManifest` 变 `null`，CDN 逐文件 `?v=` 全丢 |

### `.assets-manifest.json` 不是构建产物

- 它在 `.gitignore:107`，`npm run build` **不生成**
- 单独命令：`node tools/build-assets-manifest.mjs`（= `npm run manifest`）
- 只扫 `public/assets`、`public/fonts`、`public/media`；**三个目录都空时打印「这份检索没有美术，不生成 .assets-manifest.json」并 exit 0** → "成功但没文件"，最容易漏

判据：`tag` 由全表 `path+hash` 的 sha256 前 16 位得到，**只随美术变化**。当前 `14afa254f9c9b681` / 42,200 条 / 7,106,837 B。

---

## 三、systemd / 进程侧的硬校验

| 变量 | 规则 | 违反的现象 |
|---|---|---|
| `SP_WS_UPGRADE_THRESHOLD` | ≥ 20（窗口 60,000ms）；ban ≥ 1h 时要 ≥ 100 | **启动即 `RangeError` 退出**（`server/http/wsUpgradeLimit.js:29`）。0.3.0 不校验，升级才炸 |
| `SP_WS_UPGRADE_BAN_MS` | ≤ 30 天 | 同上 |
| `SP_REDIS_PREFIX` | **必须带冒号**，如 `stronghold:` | 生成 `strongholdindex` / `strongholdruntime` / `strongholdcp:<code>` 这类错键，旧键读不到 = 全部对局丢失（`server/redis.js:34`，代码不会自动补冒号） |
| `SP_GEOLITE_COUNTRY_DB` | 不要指进游戏目录，或保证该文件随 release 一起继承 | 翻符号链接后 ENOENT，进程退出 |
| `SP_STATE_SAVE_MS` | 30,000（10s 时单次小写 10–19ms 是 PSI IO full 主因） | — |

另外：同一批 `SP_*` 变量如果在多个 drop-in 里各写一个值，**最后加载的那份生效**，前面的静默失效。上线前把 `systemctl cat` 全看一遍。

**地区库看不到 ≠ 判定为非国内。** `cn-only` 模式用的是 IPv4 表，IPv6 地址在那个库里本来就查不到。这种"这个源没法判"必须走"无结论"通道（`server/geoip.js` 返回 `undefined`），而不是返回 `ZZ` —— 否则国内 IPv6 玩家会被一刀切拒在门外，而日志里只会写一行普通的拒绝。反过来，IPv4 查不到（表里真没有）仍然算非国内，这是 2026-10-17 的决定，不要顺手改掉。

---

## 四、nginx 侧的坑

1. **`limit_req_status` / `limit_conn_status` 不要留 444。** 444 是直接断连，客户端只看到 `000`，拿不到 `Retry-After`，无法退避。用 429 + `Retry-After: 60`。
2. **`location ^~ /build/` 从磁盘直发，不经过 node。** 所以 node 里 `static.js:493` 发的 `Service-Worker-Allowed: /` 到不了浏览器 → Service Worker 注册报 `SecurityError`（scope `/` 不在 `/build/assets/` 之下）→ **SW 永远装不上，客户端没有任何本地缓存，每次打开都重拉几百个模块**。必须在 nginx 这条 location 里手动加 `add_header Service-Worker-Allowed "/" always;`。
3. **`http2_max_concurrent_streams` 默认 128。** 一次页面加载会并发 `import` 数百个 `sim/content` 模块，超出的流被 `RST_STREAM` 掐掉 → 控制台 `ERR_HTTP2_PROTOCOL_ERROR`、页面半死、反复重载。设 512。
4. **`keepalive_requests` 默认 1000。** 长开标签页重载几次就撞 `GOAWAY`，在途请求被打断。设 100000。
5. **`add_header` 在 location 里出现一次，父级的全部失效。** 安全头要在每个自带 `add_header` 的 location 里重新 include，不能指望继承。
6. **`^~` 前缀 location 优先于正则 location。** 想用正则命中 `/build/assets/` 必须先确认没有被 `^~ /build/` 截走。
7. **同补丁要按机落点。** 同一个 `snippets/fleet-game-locations.inc` 在 h2 上是活的，在 h3 上是孤儿文件（只被 `conf.d.legacy-*` 引用），改它完全无效。改之前先 `nginx -T | grep 'configuration file'` 确认活文件集合。
8. **`/healthz`、`/build/`、`/icons/` 必须 `auth_request off`。** 否则探活和首屏静态被浏览器闸门挡住（表现为首屏图标 444、探活失败）。
9. **闸门判定别只认 `Accept`。** `Accept: */*` 的 WebView 会被一律 444 白屏。用 `Sec-Fetch-Mode: navigate`。

---

## 五、切换（换版本）的标准顺序

`/opt/sp-public` 与 `/opt/sp-data` 是指向 `/opt/Stronghold-Protocol/{public,data}` 的符号链接。**把 `/opt/Stronghold-Protocol` 本身换成符号链接**，代码和静态一起原子切换，nginx 不用改也不用 reload。

只改 systemd drop-in 指向新目录是错的：Node 跑新代码，但 nginx 仍从旧目录发 `public/build`，玩家拿到旧产物，且没有任何报错。

```
systemctl stop stronghold
# 1. 校验 release：node_modules / public/build / data/*.json / .assets-manifest.json
# 2. 继承：见第二节那张表
# 3. 搬运行时目录：.state
mv /opt/Stronghold-Protocol /opt/stronghold-releases/<host>-retired-<UTC>
ln -s /opt/stronghold-releases/<host>-<新> /opt/Stronghold-Protocol
readlink -f /opt/sp-public /opt/sp-data
systemctl start stronghold
```

回滚 = `rm` 链接 + `mv` 回旧目录 + `daemon-reload` + `start`。

**没有 `sp-public`/`sp-data` 链接的机器**（h1 就是这样）要把 `/opt/Stronghold-Protocol` 变成链接并补建这两个，否则 nginx 三处硬编码的 `root /opt/Stronghold-Protocol/public` 会一直发旧文件。

---

## 六、验收看什么

**跨机可比的只有三项**：

1. `git rev-parse HEAD` == 目标 commit
2. `/healthz` 的 `assetsManifest` == 目标 tag（当前 `14afa254f9c9b681`）
3. `public/build` 的文件清单与参照 release 一致

**`build` / `runtimeVersion` / `artVersion` 每台都不一样，不要比对。** `server/assetVersion.js:51/52/95`：runtime 折进了 mounts 下每个文件的 `url+digest` 和 `server/index.js`，art 还折进了 `JSON.stringify(cdn)`（即本机 `SP_ASSETS_CDN`）。同版本的三台机器算出来是三个不同值，这是正常的。

**对局连续性**：切换前后 `/metrics` 的 `rooms` / `sessions` / `matches` 一致；日志里出现 `session.resumed` 且 `offlineMs` 在几百到几千毫秒内。

**浏览器侧**：控制台不允许出现下面任何一条 —— 出现就是没部署干净：

```
SecurityError ... ServiceWorker ... max scope allowed
ERR_HTTP2_PROTOCOL_ERROR
resource-sw ... not registered
```

---

## 七、回滚

改动前把整棵树打了包再说。回滚粒度按组件分，不要指望"一键回整机"：

```
nginx:  tar -czf <备份>/nginx.tgz -C /etc nginx
        回滚： rm -rf /etc/nginx && tar -xzf <备份>/nginx.tgz -C /etc && nginx -t && systemctl reload nginx
游戏:   删链接 + mv 回 *-retired-* + daemon-reload + start
env:    cp -a 备份/unit-dropin 回 /etc/systemd/system/stronghold.service.d/
```

**顺序守则**：`nginx -t` 不过就立刻整树还原并退出，绝不 reload；游戏起来不健康就立刻翻回链接，绝不留着"再看看"。
