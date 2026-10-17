# 机房来源分级：可行性与边界

2026-10-17 核对仓库 `GeoLite2-Country.mmdb`：116.198.45.213、47.103.57.77、111.228.63.76、49.233.9.157、120.202.218.34、39.96.95.150、180.164.155.112 均返回 CN。报告中的“现有大陆库把这批攻击 IP 判为 ZZ，因此是住宅白名单”不适用于本仓库全球库。`server/geoip.js` 的 ZZ 只是 cn-only 模式下 IPv4 未命中的策略标记，不能证明机房身份。

Country 只识别国家。需要额外 ASN 数据才能查运营网络；ASN 仍不是精确的住宅/机房标签。同一个运营网络可能同时服务家庭、企业和 IDC，住宅代理也可能用于攻击。[MaxMind ASN 字段](https://dev.maxmind.com/geoip/docs/databases/asn/)与单独的[Hosting/匿名网络字段](https://dev.maxmind.com/geoip/docs/databases/anonymous-ip/)是不同数据产品。

国内服务器可以通过已有 Nginx GeoIP2 模块另读 ASN MMDB，记录 ASN 与“待确认机房”分类，先观察拒绝时的同时在线连接与正常会话，再启用差异化额度。未知 ASN 不自动当成机房；不按宽泛的电信/联通/移动 ASN 整体封禁；单独维护、校验 IPv4/IPv6 数据与回滚。当前仓库只带 Country，没有 ASN 或 hosting 数据，因此本次没有自动添加 IDC 黑名单。

CF 侧也支持 ASN 条件，但表达式使用数值，例如 `ip.src.asnum in {37963 45102}`，不是 `{AS37963 AS45102}`。Managed Challenge 应考虑页面导航与 API/WS 的区别，WebSocket 客户端无法显示交互挑战页面；需要单独验证登录后的升级链路。[Cloudflare ASN 自定义规则](https://developers.cloudflare.com/waf/custom-rules/use-cases/update-rules-customers-partners/)

“一小时 19 条 WS”是累计连接次数，不能推导同时并发 19。“只访问 1～2 个路径”也可能是 CDN、缓存或已打开的客户端，不单独据此永久封禁。CGNAT 共用同一公网出口，按 IP 的 4 条并发和平均 5 次新建/分可能限制真实玩家；这是用户当前明确指定的参数，未自动改成报告建议的 16 条。
