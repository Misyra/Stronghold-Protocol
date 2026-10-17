# ops/ — 内核层封禁（仅服务器侧，不进玩家包）

```
ops/banned-ips.txt        永久封禁名单（source of truth）
ops/sp-syn-ban-load       读名单 + 建 nft 表，脚本本身可以重复跑
ops/sp-syn-ban.service    开机/手动加载用的 oneshot unit
ops/sp-web-syn-guard.nft  每 IP 的 SYN 速率闸（规范值，见下）
ops/cloudflare-net-block.rules  Cloudflare 边缘的 ASN / 地区 / IP 屏蔽表达式（与服务端 server/netBlock.js 同一份名单）
ops/blocked-ipv4.txt      生成物：server/netBlock.js 的逐条 IP（IPv4），由 tools/net-ban.mjs 渲染
ops/blocked-ipv6.txt      生成物：同一份名单里的 IPv6（当前为空）
```

这三件只属于部署机。`tools/package.mjs` 的 `RUNTIME_DIRS` 不包含 `ops/`，所以
它们不会进玩家发行包，跟 `geoip/` 是同一个理由。

## 装

```bash
install -m 0644 ops/banned-ips.txt        /etc/stronghold/banned-ips.txt
install -m 0755 ops/sp-syn-ban-load       /usr/local/sbin/sp-syn-ban-load
install -m 0644 ops/sp-syn-ban.service    /etc/systemd/system/sp-syn-ban.service
systemctl daemon-reload
systemctl enable --now sp-syn-ban
```

## 改名单

两种来源，加载器合并进同一个 `perm4`：

| 文件 | 谁维护 | 装到 |
|---|---|---|
| `ops/banned-ips.txt` | 人手写（一行一个，支持 CIDR 与 `#` 注释） | `/etc/stronghold/banned-ips.txt` |
| `ops/blocked-ipv4.txt` / `blocked-ipv6.txt` | `node tools/net-ban.mjs` 从 `server/netBlock.js` 生成，**不要手改** | `/etc/stronghold/blocked-ipv{4,6}.txt` |

```bash
install -m 0644 ops/banned-ips.txt       /etc/stronghold/banned-ips.txt
install -m 0644 ops/blocked-ipv4.txt     /etc/stronghold/blocked-ipv4.txt
install -m 0644 ops/blocked-ipv6.txt     /etc/stronghold/blocked-ipv6.txt
systemctl restart sp-syn-ban
```

脚本先 `nft -c -f` 校验，再把 `delete table` 与新表放进同一份输入——**一个事务，没有先删后建的空窗**，
写坏了不会把现有规则搞丢。

## 升级名单（应用层名单变了 → 内核层跟上）

```bash
node tools/net-ban.mjs             # 重写 ops/blocked-ipv{4,6}.txt
node tools/net-ban.mjs --check     # 部署前确认没有漂移（不一致就退出 1）
sudo install -m 0644 ops/blocked-ipv4.txt /etc/stronghold/blocked-ipv4.txt
sudo install -m 0644 ops/blocked-ipv6.txt /etc/stronghold/blocked-ipv6.txt
sudo systemctl restart sp-syn-ban  # 原子替换，不断流
```

**一个代价**：整表替换会顺带清空 `auto4` 里已经积累的 24h 自动封（永久名单不受影响）。想保留就只加元素：

```bash
sudo nft add element inet sp_syn_ban perm4 { 1.2.3.4, 5.6.7.0/24 }
```

增量加会写进内核但不进文件，重启（或下次整表替换）就没了——临时封用这个，长期封改文件。

**内核层做不到 ASN**：nft 没有 ASN 概念，`perm4/perm6` 只吃地址和 CIDR。133 个 ASN 不展开成 CIDR
（会撑爆 `size 65536` 且归属一变全废），它们由 `server/netBlock.js` 在应用层实时判定；
地区 TW/VE/EC 要进内核得走 `scripts/hardening/render-country-firewall.py` 那条从 MMDB 遍历前缀的链。

## sp-web-syn-guard.nft

`sp_syn_ban` 管**已知**的洪水源（名单 + 20 SYN/s 自动封），这份表管**每 IP 的连接速率**，
两者叠加：`sp_syn_ban` 在 `priority filter - 6`，本表在 `- 5`，所以名单里的 IP
先被丢掉，到不了这里。

```bash
sudo nft -f ops/sp-web-syn-guard.nft     # 幂等：同名表会先被删掉再建
```

**注意**：`nft -f` 一个已经存在的同名表会报 `File exists`。要替换就写在一个文件里：

```bash
{ echo 'delete table inet sp_web_syn_guard'; cat ops/sp-web-syn-guard.nft; } | sudo nft -f -
```

（nft 把整份输入当一个事务，所以 delete + add 之间没有窗口。）

替换会清空 `web_syn4 / web_syn6` 里的实时元素和计数器——对误伤的 IP 来说这是好事。

阈值怎么来的、为什么是 30，写在文件头的注释里。

## 表结构

```
table inet sp_syn_ban
  set perm4   flags interval, size 65536            无 timeout → 永久
  set auto4   flags timeout, size 262144, 24h       自动封
  chain input priority -6
    iifname "lo" return                     ← 本机流量不参与封禁/限速
    ip saddr @perm4 drop                            ← 先跑，命中就结束
    ip saddr @auto4 drop
    tcp dport {80,443,3000,8080} syn jump syn
  chain syn
    meter synrate { ip saddr limit rate over 20/second burst 40 packets }
      update @auto4 { ip saddr } drop
    limit rate over 500/second burst 1000 packets drop   全局兜底
```

**顺序有意义**：`perm4` 在 `jump syn` 之前，所以已在永久名单里的 IP 不会进
meter —— `auto4` 只负责抓名单之外新冒头的。实测确认这两条都工作
（2026-10-17：`perm4` 计数 9.3 万包，用临时表验证过 `meter … update @auto4` 真会
把 IP 写进集合）。

## 为什么不靠 `/etc/nftables.conf`

这台机器的 `nftables.service` 是 `enabled` 但 `inactive`，`/etc/nftables.conf`
开机根本不执行，现有表全是手工 `nft -f` 打的。而且那份 conf 里有 `flush ruleset`，
一旦启用会顺手清掉 ufw 的 `table ip filter` / `ip6 filter`。所以这里自带 oneshot
unit，不碰 nftables.service。

## cloudflare-net-block.rules

三份可粘贴的 Cloudflare 自定义规则表达式（ASN 133 个、地区 TW/VE/EC、逐条 IP 84 个）。
服务端 `server/netBlock.js` 是同一份名单、默认开启；改名单两边一起改。为什么名单里混着两个运营商号码，
以及各条规则的边界，见 [`custom_docs/operations/IDC_PROTECTION.md`](../custom_docs/operations/IDC_PROTECTION.md)。
