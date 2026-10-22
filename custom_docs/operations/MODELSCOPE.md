# ModelScope 资源分包

本站默认采用 `Misyra/Arknight_Assets` 数据集，机制改编自
[xinhai-ai/Stronghold-Protocol](https://github.com/xinhai-ai/Stronghold-Protocol/blob/e01036ae62acf1be17a118e6a6ef116cbb747b13/docs/RESOURCE_PACKS.md)。
资源管理器优先下载带完整 SHA-1 的分类 ZIP；两路网络下载与一路校验、展开和缓存导入分离，整包验证后按当前资源清单的
路径、大小及哈希导入 Cache Storage。分包缺失或网络/校验失败时尝试下一线路，最后逐文件补齐。
一次预载阶段共享一个导入会话，避免每导入一个小包都重新扫描全部缓存。
下载完的包按完成顺序交给单路导入器，最多排队两个 ZIP；两条网络通道各自最多持有一个正在下载或等待入队的包。
消费端忙时网络可以继续，队列满后才暂停取新包，避免无界缓冲。界面分别提示下载、等待和校验导入。
所选分类共用下载队列，必备包优先；一个必备包等待重试时，空闲通道可继续下载语音、皮肤和特效。
本站不配置游戏服务器的资源包代下、缓存或转发，玩家仍直接访问 ModelScope，现有 CDN 作为兜底。
每条线路允许等待响应头 20 秒、下载中断流 20 秒、单次网络总耗时 180 秒；持续有数据的下载不会因总耗时超过 20 秒而重试。
校验和缓存导入不计入网络计时。瞬时网络错误、超时及部分可重试
HTTP 状态先在同一线路重试一次，再切换备用线路。404、格式或摘要错误不在同一线路重复下载。

## 生成和发布

在持有完整素材的发布机运行：

```powershell
npm run resources:packs
# 只生成特效和皮肤时：npm run resources:packs -- --scopes fx,skin
npm run resources:publish
```

第一条生成 `public/resource-packs/*.zip` 与 `data/resource-packs.json`；每包最终不超过 16,000,000 字节，
文件名单独超过限制的资源保留逐文件下载。默认包含全部素材；特效单独分类、皮肤跨套合并装包，语音按语种分类。
皮肤沿用原来的每包 16,000,000 字节上限，装不下的文件进入下一包，最后余量单独成包；不会按单套皮肤生成小 ZIP。
`--scopes skin` 仅替换皮肤包索引，其余分类的已有包保持原样；历史 ZIP 文件保留。
ZIP 采用 stored 条目以匹配流式传输读取器。文件内容不变时包字节与文件名保持稳定；素材不入 Git。
`--python python3` 可选择分包脚本的 Python。生成阶段会重新验证本机字节，不下载素材、不修改 R2 发布指纹。

发布脚本默认只预演。首次安装发布依赖，然后验证 token 或正式上传：

```powershell
python -m pip install modelscope-hub==0.4.6
python tools/modelscope-packs.py --check-auth
npm run resources:publish -- --apply
```

脚本从 `MODELSCOPE_API_KEY`（兼容 `MODELSCOPE_TOKEN`）读取凭据，未提供时隐藏输入；
不会调用持久化登录，不将 token 写入源码、分包、日志或浏览器。玩家只访问公开数据集直链，无需 token。
`MsDataset.load` 面向数据集读取，浏览器下载 ZIP 使用 `/resolve/master/{file}`，不加载 Python 数据集。

上传目标默认是已有的 `Misyra/Arknight_Assets`；`--dataset owner/name` 可覆盖，`--revision master` 可指定版本。
只上传当前索引点名的 ZIP，全部成功后才发布索引；保留远端已有文件及旧版大包，不自动删除或替换其内容。
SDK 会按内容复用 LFS blob，最多四路上传，并批量提交以减少仓库提交限流；
`.cache/modelscope-publish/` 保存按数据集、分支和索引隔离的续传记录，不保存 token。
发布机的 `data/resource-packs.json` 与匹配的素材指纹必须随服务部署。
可另行使用现有 R2 发布脚本上传相同 ZIP，供兜底线路使用。

## 下载线路

游戏进程默认使用：

```text
https://modelscope.cn/datasets/Misyra/Arknight_Assets/resolve/master/{file}
```

当前 `SP_ASSETS_CDN` 对应的 `/resource-packs/{file}` 自动留在最后；只有索引存在时才会请求 ZIP。
页面 CSP 根据配置的镜像线路放行下载连接；ModelScope 的公开分包会跳转到
`cdn-lfs-cn-*.modelscope.cn`，因此同时允许其子域连接，不增加脚本或 Worker 来源。
`SP_RESOURCE_PACK_ROUTES` 可覆盖默认线路，例如：

```powershell
$env:SP_RESOURCE_PACK_ROUTES = '["https://modelscope.cn/datasets/Misyra/Arknight_Assets/resolve/master/{file}"]'
# 显式禁用镜像，仍从当前 CDN 取 ZIP：
$env:SP_RESOURCE_PACK_ROUTES = '[]'
```

普通分类在所选资源缺失字节达到 25% 才整包下载；合并皮肤包只要所选皮肤仍有缺失，就继续使用 ZIP 补齐，避免大量逐文件请求。
合并包只导入当前选择的皮肤，未选择的条目跳过；所选内容已全部缓存的包不下载。混有未选语种的包仍跳过。
关闭皮肤预载时不请求皮肤 ZIP，游戏使用 `assets.misyra.com` 原有素材地址按需加载。
ModelScope/CORS/超时/整包摘要失败只影响对应分包；缓存写入和磁盘配额失败停止导入并保留已经写入的进度。
普通战斗按需加载仍使用当前素材地址，此机制不把每个 PNG/JSON 单独重定向到 ModelScope。

## 旧版大 ZIP 兼容

16 MB 仅限制自动传输分包。资源管理器的手动「导入 ZIP」继续支持原有 v1（SHA-256）和 v2（完整 SHA-1）包，
保留原有 2 GiB 包、24 MiB 单文件、50,000 条目等边界及 CRC/大小/摘要校验，也支持 deflate 压缩条目。
旧包无需重新导出：当前清单仍认可的内容跨版本、跨 CDN 地址复用；已变化或已删除的文件跳过。
旧包导入与新分包写入同一套资源缓存，因此导入后只补齐当前选择缺少的资源。
不要将旧的大 ZIP 填进 `SP_RESOURCE_PACK_ROUTES` 作为每个小分包的替代地址；两者的清单与摘要不同。

部署前运行 `npm run build`；上传 ZIP 后再部署索引和客户端。这里的发布命令不重启、不部署游戏服务器。
