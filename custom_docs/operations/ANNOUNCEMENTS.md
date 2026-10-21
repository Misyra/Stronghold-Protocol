# 游戏内公告

公告本身只要求一件事：**游戏进程能读到一份 JSON**。谁来写它都行——面板加探针只是自动化程度最高的一种写法，不是前提。没有探针的站点直接改仓库里的 `config/announcements.json` 就能发，见[没有探针时怎么发公告](#没有探针时怎么发公告)。

下面的默认链路是「面板 + 探针」这条路，方便多台机器统一发布；它和你手工改文件写的是同一个位置（受管理的那份文件），探针只负责原子替换与版本号。

## 没有探针时怎么发公告

两条路，都不需要装任何东西：

**1. 改 `config/announcements.json`（推荐，什么都不用配）**

默认的 `agent` 模式先读探针那份受管理文件，**读不到就退到仓库自带的 `config/announcements.json`**（`server/http/config.js:76-80`、`server/announcement.js:111-115`）。一份干净 checkout 里它就是 `{"announcements": []}`，往里加条目即可：

```json
{
  "announcements": [
    {
      "id": "maintenance-20261021",
      "text": "服务器将于 17:00 开始维护，请提前结束模拟。",
      "startAt": "2026-10-21T17:00:00+08:00",
      "durationSeconds": 3600,
      "level": "warning",
      "enabled": true
    }
  ]
}
```

`startAt` 和 `durationSeconds` 都必填（滚动公告 1–86400 秒，到期自动下；`endAt` 只给 `type: "popup"` 用）。`id` 唯一、1–64 位字母数字下划线连字符。`level` 取 `ANNOUNCEMENT_LEVELS`（默认 `info`），`text` 最多 500 字、单行折叠空白。**改文件不用重启**，游戏每秒最多读一次，10 秒内生效。写坏了不生效而不是发半条：整份文档原子校验，失败保留上一版有效内容。

**2. `SP_ANNOUNCEMENT_SOURCE=file` + 根目录 `announcement.json`**

单条公告的老格式，照 `announcement.example.json` 写（`enabled` / `title` / `text` / `displayMode` / `expiresAt`）。适合「整个服就一条维护公告、不想维护数组」的场合。

两条路的区别只有一个：文件在哪、格式是数组还是单条。功能一样，都支持 `displayMode`、到期、`/api/announcement` 的版本提示。

**什么时候才值得上探针**：多台机器、想让人在网页上点一下发布、想看到「面板保存 → 探针写入 → 游戏读到」三层状态。单机改文件的维护量低于装探针的维护量，就不该装。

## 默认链路

```text
/ops/manage.html 发布 → 面板公告存储（PANEL_ANNOUNCE_FILE）
    → PUT /api/admin/v1/announcement（本站探针，管理密钥）
    → /var/lib/stronghold-announcement/announcement.json（原子替换）
    → 游戏 GET /api/announcement → 玩家浏览器
```

面板先持久化内容和每站递增版本，再并行推送。失败站点在监控轮询时重试（默认 10 秒），面板重启后也会补发；成功站点不受其他站点故障影响。探针拒绝旧版本覆盖，重复请求可安全重试。停用或删除公告也会作为带版本的撤下指令补发。公告到期由游戏和浏览器独立判断。

游戏每秒最多读取一次文件。新客户端通过现有 WS `pong.announcementRevision` 获得公告内容版本提示，有变化才拉取 HTTP 内容；心跳连续有效且版本不变时跳过普通 30 秒轮询，最长 3 分钟仍复核一次。提示超过 12 秒未更新、服务端为旧版或 WS 不可用时，恢复 30 秒 HTTP 兜底；隐藏标签页不轮询，切回后立即复核。安装本仓库 Nginx 缓存片段时，公告在源站共享缓存 5 秒；浏览器仍收到 `no-store`。WS 版本变化和切回页面时使用 `?nocache=1` 绕过共享缓存。「已写入探针」表示文件写入成功，「线上生效」列显示实际游戏接口内容。

WS 提示仅为当前公开滚动/弹窗内容的 24 位哈希，不含 `_delivery`、管理版本或公告正文；编辑、撤下、定时开始与到期都会改变提示。所有心跳共用非阻塞的读取结果，不为每位玩家重复读文件，不新增 WS 消息或协议版本要求。新旧客户端/服务端可混用，交付与公告内容仍由原 HTTP 接口提供。此为本地代码变更，需后续部署才生效。

## 三层状态与「读到的版本」

公告的交付有三层，缺一层就说不清故障出在哪：

1. **面板保存**：内容与每站递增版本落在 `PANEL_ANNOUNCE_FILE`；
2. **探针写入**：公告文件被原子替换（文件里带 `_delivery.revision`）；
3. **游戏读到**：游戏进程真的把这一版读进内存了。

第三层由游戏自己回答：`GET /api/announcement` 除公告本身外返回 `observedRevision` / `observedAt` —— 它读到的**那一份文件自述的版本号**以及读到的时间。探针与中央据此区分「文件写好了但游戏还没读到」和「根本没写进去」；只比对文件内容做不到这件事，因为两者在被读之前看起来一模一样。

- 手工写的文件（没有 `_delivery`）返回 `observedRevision: null` 与读到的时间：如实表示「读到了文件，但它没说自己是哪一版」，不猜一个 0。
- 撤下公告（`enabled:false`）同样留下版本号：撤下是它读到的一份文件。
- 读取失败不会回退这个值 —— 「现在读不到」不等于「从来没读到过」。交付记录本身（`_delivery`）**不进**公开投影，玩家可见的公告内容与 `announcement.id` 的展示策略一个字都没变。

## 显示方式与有效期

管理页分别配置有效期和显示方式。选择「30 分钟」会在发布时生成统一的 `expiresAt`：发布 30 分钟后全体过期，迟进入的玩家不会重新获得 30 分钟。另有 1 小时、6 小时及原有较长档位。

- `displayMode: "once"`（默认）：关闭后，同一浏览器不再显示该版本，刷新也不会重新显示；新公告或修改内容后重新显示。
- `displayMode: "visit"`：每次重新打开或刷新游戏页面都会显示；关闭后，本次页面内的轮询、切换界面和断线重连不会让它重新出现。

两种方式都受统一过期时间限制。旧配置省略 `displayMode` 时保持原有关闭记录和公告 ID；清理浏览器存储或换浏览器会失去「只显示一次」记录。面板、探针和游戏须一起更新才能完整支持新模式。

## 接入和升级

**不装探针的站点什么都不用配**：默认 `agent` 模式读不到探针那份文件就会退到 `config/announcements.json`，改文件即发布（见[没有探针时怎么发公告](#没有探针时怎么发公告)）；要单条格式就设 `SP_ANNOUNCEMENT_SOURCE=file`。

**要走面板发布才需要探针**。探针与面板都属于 sp-portal 项目，不随本仓库分发，本仓库只负责读那份文件：

1. 在 sp-portal 目录生成 `ops/` 产物树（`npm run sync:agent`，`npm run check:agent` 校验），整份放到本站 `/opt/stronghold-ops`。
2. 运行产物树里的 `/opt/stronghold-ops/deploy/install-agent.sh`。已有 env 保留，脚本自动补充独立的 `SP_ADMIN_TOKEN_RW`、公告目录及 systemd 写权限。中央面板的部署以 sp-portal 当前文档和模板为准。
3. 在面板站点配置中填写本站探针 URL 和 `admin.env` 中的 `SP_ADMIN_TOKEN_RW`，测试连接后保存。它可读取监控并写公告；旧 `SP_ADMIN_TOKEN_RO` 仍只能读取监控。
4. 升级已有 feed 部署时，把**游戏服务**环境设置为 `SP_ANNOUNCEMENT_SOURCE=agent` 后重启游戏。新安装不设置来源即可使用 agent。安装脚本不会擅自改动游戏服务环境。
5. 在管理页发布并检查推送状态及线上内容。

走探针时，默认 Linux 公告目录为 `/var/lib/stronghold-announcement`，由 spmonitor 持有，目录 0755、公告文件 0644，只存放玩家可见内容。探针仅有该目录的写权限，不允许通过请求修改路径、游戏程序或服务配置。自定义目录需使用安装器支持的 /var/lib 下独立目录，并同时设置探针 `MON_ANNOUNCEMENT_FILE` 和游戏 `SP_ANNOUNCEMENT_AGENT_FILE`。

Docker 游戏须将宿主机**整个公告目录**只读挂载到容器同一路径（不要只挂载单个文件，原子替换会更换 inode）；见 [DEPLOY.md](DEPLOY.md#docker)。Windows 游戏默认读项目 `.state/announcement.json`；若自行运行探针，请将两个进程的上述文件配置设成同一个绝对路径。

| 游戏环境变量 | 行为 |
|---|---|
| `SP_ANNOUNCEMENT_SOURCE` | 默认 agent；显式 URL 且未指定来源时兼容为 panel；另支持 file |
| `SP_ANNOUNCEMENT_AGENT_FILE` | agent 模式的探针管理文件；Linux 默认上述路径 |
| `SP_ANNOUNCEMENT_URL` | panel 模式的完整 feed URL；已有显式 URL 继续有效 |
| `SP_PORTAL_URL` / `SP_SITE_ID` | panel 模式未指定完整 URL 时必填；没有绑定某一站点的默认值 |
| `SP_ANNOUNCEMENT_POLL_MS` | feed 最短拉取间隔 10000 毫秒，限制 3000–600000 |
| `SP_ANNOUNCEMENT_FILE` | 仅显式 file 模式使用；默认根目录 announcement.json |

上表全部是**游戏服**读的。下面三个不属于本仓库，写进游戏的 `.env` 不会有任何效果：`MON_ANNOUNCEMENT_FILE`（探针写哪份文件）、`SP_ADMIN_TOKEN_RO` / `SP_ADMIN_TOKEN_RW`（面板连探针的凭据）。探针与面板都不随本仓库分发。

## 无探针站点的 feed 接入

面板仍提供公开 `GET /api/announce/v1/<siteId>`，仅包含玩家可见字段。游戏可继续配置：

```dotenv
SP_ANNOUNCEMENT_SOURCE=panel
SP_ANNOUNCEMENT_URL=https://<游戏域名>/api/announce/v1/<面板中本站的实际ID>
```

国内、国内2、香港 ID 分别为 shiyan、aliyun、hongkong；其他站点从面板配置读取实际 ID。feed 拉取失败保留最后有效值；明确 enabled:false 撤下，到期仍隐藏。故障不会自动切换来源。没有配置探针的站点在面板显示「由游戏拉取 feed」。

## 手工文件模式

仅用于独立部署：显式设置 `SP_ANNOUNCEMENT_SOURCE=file`，按 `announcement.example.json` 创建手工公告。根目录旧 announcement.json 不会被默认 agent 模式读取；探针只写受管理文件。标题 1–80 字符、正文 1–2000 字符，expiresAt 必须是带时区的 ISO 时间。内容支持换行，不解析 HTML。文件最多 16 KiB，修改无需重启。

## 排错

- 「请升级探针并填写管理密钥」：探针缺少写入能力，或面板仍在用只读密钥。
- 「等待重试」：检查探针连接、密钥、目录权限及 `journalctl -u sp-admin`。不要只重启游戏。
- 「游戏仍使用旧公告来源」：游戏环境切为 agent 后重启；核对 `curl -s http://127.0.0.1:3000/api/announcement` 的 source.mode。
- 文件已写入但游戏无公告：核对两个进程文件路径、游戏账号读取权限、Docker 目录挂载、过期时间。
- 代理返回旧值：先请求 `/api/announcement?nocache=1`，确认 Node 当前内容；Nginx 普通公告共享缓存最长 5 秒，且源站失败时不返回过期公告。`serverTime` 的缓存年龄由客户端按 `Age` 头修正；WS 版本变化会绕过缓存刷新。中央 feed 由 sp-portal 提供。
- 版本冲突：检查该探针是否被误配置到两个面板站点，修正后重新发布。中央公告存储需和私有探针配置一起备份。

游戏内公告和入口页公告是独立系统：前者保存在 PANEL_ANNOUNCE_FILE、每站一份；后者由 PORTAL_ANNOUNCEMENT_FILE 管理、多条轮播，通过 /api/notices 展示。不要交叉修改两套文件。
