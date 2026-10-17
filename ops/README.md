# ops/ — 内核层封禁（仅服务器侧，不进玩家包）

```
ops/banned-ips.txt       永久封禁名单（source of truth）
ops/sp-syn-ban-load      读名单 + 建 nft 表，脚本本身可以重复跑
ops/sp-syn-ban.service   开机/手动加载用的 oneshot unit
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
