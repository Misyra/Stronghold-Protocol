# ops/ — 内核层封禁（仅服务器侧，不进玩家包）

```
ops/banned-ips.txt        永久封禁名单（source of truth）
ops/sp-syn-ban-load       读名单 + 建 nft 表，脚本本身可以重复跑
ops/sp-syn-ban.service    开机/手动加载用的 oneshot unit
ops/sp-web-syn-guard.nft  每 IP 的 SYN 速率闸（规范值，见下）
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

加一行 IP 到 `ops/banned-ips.txt`，部署后 `systemctl restart sp-syn-ban`。
脚本会先 `nft -c -f` 校验再替换表，写坏了不会把现有规则搞丢。

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
    ip saddr @perm4 drop                            ← 先跑，命中就结束
    ip saddr @auto4 drop
    tcp dport {80,443,8080} syn jump syn
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
