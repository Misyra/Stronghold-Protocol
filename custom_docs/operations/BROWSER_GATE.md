# 自动浏览器入口验证

独立回环服务配合 Nginx `auth_request`，在页面、静态直出、缓存、API 和 WebSocket 升级前校验签名 Cookie。首次浏览器导航返回验证页；其余未验证业务请求返回 Nginx 444。只放行 `/_gate/` 下服务明确支持的验证页面、脚本、challenge、verify 和只读 status；未知路径不转发给游戏。本机 `/healthz` 监控例外，不开放公网诊断。

2026-10-19 的恢复探针与扩展续期已在本地实现，尚未部署生产；下列内容描述更新后的仓库行为。2026-10-17 的现场记录保留在文末，不代表新版已上线。

这是一项工作量证明准入，不是真人识别。机器人也能完成计算，获得凭证后仍受已有频率、连接数和永久封禁约束。不要通过 User-Agent、Accept 或客户端 IP 头授予权限；Accept 仅决定显示验证页还是断开连接。

默认 SHA-256 前导 18 位零，浏览器 Worker 计算、服务器只验证一次哈希。challenge 有效 120 秒，绑定真实来源 IP、站点和 UA；提交后在进程内标记已用，缓存最多 10000 条，满时拒绝新验证。重启会清除短期重放缓存。签名 Cookie 有效 6 小时，HttpOnly、SameSite=Lax、无 Domain；HTTPS 使用独立的 `__Host-sp_browser_gate` Cookie 并加 Secure；HTTP 使用 `sp_browser_gate`。凭证同时绑定协议，防止跨 HTTP/HTTPS 使用及同名 Secure Cookie 冲突。有效凭证进入后半个有效期后，任意受保护请求都可生成续签头，由 Nginx 写入当前响应；已失效的凭证仍须重新解挑战。IP 绑定保留，移动网络换出口由自动恢复路径重新验证。已有 WS 不被入口主动踢掉。

`GET /_gate/status` 是可读恢复探针：服务对无效或缺失 cookie 返回 `200 + X-Gate-Required: 1`，有效且未封禁返回 204；校验有效 cookie 后若封禁检查失败，则返回 403/503。Nginx、GeoIP 或网络层仍可能按既有规则拒绝请求，客户端只有收到明确的 200+标记才判断需要验证。服务响应均为 `no-store`。失败不签发凭证，也不转发游戏请求。有效 cookie 可由此续期，凭证只放在 HttpOnly 的 Set-Cookie 中。该 exact location 使用 server 原有业务/全局限额，不占 challenge/verify 的签发桶。

WS 连续失败时，前台页面每 10 秒最多一次探测；持续 20 秒且有明确的 `X-Gate-Required` 标记才导航恢复。普通 429、503、网络错误、旧部署上的 404 都不触发刷新；恢复连接、手动关闭或切入后台后的迟到结果被忽略。自动刷新间隔至少 60 秒，10 分钟窗口最多 3 次（跨页面保留）；耗尽后停止 WS 自动重试并显示手动刷新提示。版本检查器也使用同一明确判据，不再把“manifest 可访问而 healthz 失败”当作验证失效。

上述次数上限属于 WS 恢复路径。版本检查器按每分钟检查、连续两次确认、对局内只提示、对局外自动导航处理，另用 `sp.gateReloadAt` 限制为每 5 分钟至多一次自动恢复；两条路径没有共享刷新预算。后台标签页不探测/自动刷新，但普通 WS 退避仍可能继续，不应声称所有后台重试都被消除。

### 业务 token 与每请求校验

签名 Cookie 即业务 token：浏览器先计算挑战答案，服务端检查后签发；浏览器自动在页面、资源、API 和 WS 升级请求中携带。客户端不能自行签发可信 token，也不必为每张图片或 WS 连接额外拼接请求头。每个受保护请求仍在独立入口服务本地校验 HMAC、过期时间、IP、Host、协议及 UA；没有把整个认证结果缓存或只凭 IP 放行。

游戏进程的 IP 封禁查询默认按精确来源 IP 缓存 **2000 毫秒**，同一来源的并发查询合并为一次；有效期从查询开始计算，慢查询不延长缓存。最多 4096 个来源条目；全部条目都在查询时拒绝额外来源，不无限扩大后端请求。过期放行结果不在后端错误时继续使用，503 和异常不持久缓存。直接部署的 nftables/fail2ban 封禁仍在网络入口即时拦截，应用内新封禁最多有约两秒查询缓存延迟。

`SP_GATE_BAN_CACHE_MS` 设置在私有 `/etc/stronghold/browser-gate.env`，允许 `0..5000`，默认 `2000`；`0` 恢复每个请求查游戏封禁接口。修改后只需重启 `sp-browser-gate`，不需要重启游戏或改前端，也无需更换签名密钥，已有 token 继续有效。缓存降低重复查询，仍保留 Nginx → 认证服务的本机调用；不承诺整个链路没有后端通信。

HTTP 下 Worker 不依赖 WebCrypto，可以计算；Cookie 和页面缺少传输加密，不能防窃听或中间人篡改，应使用 HTTPS。此机制不替代 TLS、国别 nft 闸门、请求限额或 WS 并发保护。

## 安装与启用

1. 将 `scripts/hardening/browser-gate/` 的四个文件安装到 `/usr/local/lib/stronghold-browser-gate/`，root 所有、目录 0755、文件 0644。服务默认只监听 `127.0.0.1:3101`。游戏端口以目标机为准：仓库 snippet 回源为 3000，旧节点记录曾使用 3100；所有回源地址与封禁查询端口必须匹配现场值。
2. 首次安装时生成独立随机 32 字节签名密钥，写入 root 0600 的 `/etc/stronghold/browser-gate.env`，字段 `SP_GATE_KEY=<base64>`；另外设置 `SP_GATE_GAME_PORT` 为实际游戏回环端口，配置 `SP_GATE_PORT=3101`、`SP_GATE_BITS=18`。已有部署升级应保留原密钥，不要重复生成。不要记录或提交密钥，轮换会让旧凭证失效。
3. 安装 `sp-browser-gate.service`，按 `command -v node` 调整 ExecStart。服务使用 DynamicUser，不需要读取游戏密钥或写游戏目录。先启动并检查日志。
4. 将 `sp-browser-gate-map.conf` 安装为 HTTP 级 include；`sp-browser-gate.conf` 安装为 server 级 snippet。**把原来 `auth_request /_sp/ip-check` 替换为 `auth_request /_sp/gate-check`**，不要配置两条 auth_request。验证服务在允许凭证后再检查原游戏封禁接口，不能丢掉原名单检查。资源清单 location 默认由 `nginx-game-cache.conf.example` 提供（需要 `sp_assets` 缓存区）；但本仓库的 fleet 部署没有单独安装 game-cache snippet，所以 `scripts/hardening/sp-browser-gate.conf` 也带了 `/data/resource-manifest.json` 和 `/assets-manifest.json` 两个 `auth_request off` location。**两者只能留一处**：如果另装 game-cache snippet，删掉 gate 里的这两个；不能同时保留两处定义，也不能使用忽略查询的 `$uri` 缓存键。service worker 的 UA 与页面不同、又不带 gate cookie，这两个清单必须免门，否则会形成 444 重试循环。
5. 保留原 403 到 444 处理和 GeoIP 闸门。gate snippet 在 server 级设置 `add_header Set-Cookie $sp_gate_renew always;`，供 HTML、业务和 WS 继承；**凡 location 自带 add_header，必须在其列表内重复这条**（至少 `/healthz`，以及部署中另加响应头的 HTML/API location），并保留已有安全头。必须同步更新 `gate.mjs`，旧服务只对 healthz 生成续签头。不要把公网健康接口改成免验证，保留健康 5 秒缓存与既有额度。
6. 更新 `sp-business-limit-map.conf`，排除内部 gate 子请求，验证脚本使用独立静态预算。图标、字体（含版本路径、Vite 哈希文件名）不消耗 per-IP 静态请求/连接桶，仍检查 gate、GeoIP 和全局连接上限；业务、模块、游戏美术保留原桶。验证入口设置独立签发速率与全局速率，不消耗游戏静态缓存。
7. 备份，运行 `nginx -t`，定时安排回滚后 reload。确认真实浏览器通过、原查询参数与片段保留；未经验证的 API、缓存 HIT、静态文件、WS 均拒绝，伪造请求头也无效；验证服务停止时必须拒绝业务，不能 fail-open。

Nginx 只访问回环验证服务，外部无法调用内部 `/_sp/gate-check`，验证服务也不暴露公网监听。只信 Nginx 覆写的 X-Gate-* 头。有 CDN 时必须先正确配置可信 realip；当前国内直连部署不接受任意转发头。

## 验证与回滚

本地回归（身份测试必须保留预加载，否则测试环境默认配额可能干扰多身份用例）：

```sh
node --import ./test/helpers/test-setup.js --test test/client-gate-reconnect.test.js test/ui/buildGuard.test.js test/client-identity-session.test.js test/ops/browser-gate.test.mjs test/ops/incident-defaults.test.mjs
```

覆盖明确标记、普通限流/错误不刷新、迟到结果、跨页刷新预算、延迟探针不被遮蔽、身份恢复、cookie 绑定/过期/续签与封禁。真实 Nginx 测试：`NGINX_PATH=... CHROME_PATH=... node --test test/ops/browser-gate.nginx.test.mjs`，包含真实浏览器 Worker、缓存与 WS；没有二进制时跳过不能算作通过现场验证。目标机先运行完整配置的 `nginx -t`，再验证续签头继承和握手。

完整修复包含已有提交 `30437428`、`2ec469e9`、`70bba335`。先升级 gate 服务、合并 Nginx snippet/map 并检查后 reload，再发布相应前端；旧标签页首次可能仍须手动刷新。游戏若在启动时固定发布版本，应安排维护窗口重启。具体上线与回滚检查见 [OPEN-ISSUES-2026-10-19.md](OPEN-ISSUES-2026-10-19.md)。

回滚先恢复原 Nginx 主配置（原 ban-only auth_request），测试后 reload，再停用入口验证服务；保留密钥私有备份。不要停止游戏、清空 fail2ban 或移除 nft。合法配置更新应审阅巡检差异后显式更新基线。

## 业务 token 校验优化部署（2026-10-17）

国内节点 `<节点地址>:<端口>` 已更新独立认证服务，启用 `SP_GATE_BAN_CACHE_MS=2000`。复用既有浏览器计算与签名 Cookie，每请求本地验签；只合并和缓存游戏封禁查询，没有新增前端请求头或修改游戏协议。仅重启 `sp-browser-gate`，游戏 PID 在本次操作前后均为 43928，签名密钥未轮换。

验证包括：100 个并发有效请求只产生一次真实封禁接口查询，坏 token 即使来源命中缓存也被拒绝，过期后后端 403/503 均不沿用旧放行；五项单元及真实 HTTP 集成测试通过。线上旧 token 保持可用，10 个静态请求期间游戏 HTTP 计数只增加一次测量用健康请求；缓存过期后重新查询，页面 200、WS 101。自动回滚已取消。

私有备份和回滚脚本在 `/root/sec-business-token-20261017-023612`，指针 `/root/sp-business-token-current`；备份含签名密钥环境文件，目录权限 0700，不放入公开目录或仓库。需要仅撤销缓存时可把 `SP_GATE_BAN_CACHE_MS` 改为 `0` 并重启认证服务，原 token 无须重新签发。
