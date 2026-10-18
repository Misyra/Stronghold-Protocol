# 本分支测试流程

## 三个入口

```sh
npm test                                    # 单元/集成测试，最多 4 个测试进程
npm test -- test/test-workflow.test.js test/ci.test.js
npm run test:browser                         # 源码 CDN / 离线资源浏览器回归，串行
npm run test:client                          # 临时构建生产包，验证启动与进入大厅
```

浏览器入口自动设置所需的测试开关，查找常见安装路径；找不到 Chrome 时明确失败，请设置 `CHROME_PATH`。CDN 美术测试仍需要本机已下载的素材和 `.assets-manifest.json`，缺失时只跳过该素材用例。离线资源使用临时假素材，不依赖官方资源。

## 本机已知的红（环境相关，与本分支功能无关）

下面这些在开发机上常年是红的，改动前先用 `git worktree` 取出上一个提交对比一次再判断，不要直接当成回归：

- `tools/local-extract/*.py` 的用例（test/ui 里的几条、extract.py 相关）：Python 在本机拿不到 HOME，脚本在启动阶段就失败。
- `npm run test:browser` 的 10 条（21 条里 11 条绿）：headless Chrome 在这个环境里取不到临时 fixture 的素材（`Failed to fetch`），CDN 源与 ZIP 导入那几条连带失败。在 `d809fd17` 的干净工作树上同样是 11 绿 / 10 红，用例名一致 —— 与「CDN / 预载 / Redis / Worker」这批移植无关。绿的部分仍覆盖关键路径：保存的预载偏好与断点续传、干员皮肤 273 套、官方特效、四张卡片的预设、双标签页 Web Locks 去重、第二次访问直接命中缓存。
- 部分插件/工作台测试需要 Windows 的符号链接权限，普通用户身份下会跳过或失败。
- 默认 1000 房上限的回收用例（test/room-reclamation）与 `/sim/` 只读目录用例（test/match/simServe）在本机也是红的，同样在干净工作树上复现。
### 各套件当前基线（本机、`--test-concurrency=4`）

性能用例（`test/sim/robustness.test.js` 的 boss field）量的是**每 tick 的 CPU 时间**（`process.cpuUsage`），不是墙钟：并行跑测试时墙钟还包含「等 CPU」的时间，四个测试进程就足以在一台本来 0.26 ms 的机器上把 0.5 ms 的线撞破。取三次最好，如果最好的一次仍然过线就再测三次（邻居的负载是一阵一阵的），连着两次都过线才判定为真的慢了。改了这里要同时更新用例头部的说明。


| 套件 | 结果 | 剩下的红是什么 |
| --- | --- | --- |
| `test/sim/**` | 927 条，924 绿 / 3 跳过 | — |
| `test/match/**` | 932 条，929 绿 / 2 跳过 | `/sim/` 只读目录用例（环境） |
| `test/ui/**` | 987 条，964 绿 / 21 跳过 | 2 条 `tools/local-extract/extract.py`（Python 取不到 HOME） |
| `test/resources/**` | 257 条，256 绿 / 1 跳过 | — |
| `test/plugins/**` | 299 条，290 绿 / 3 跳过 | symlink/平台类 1 条；既有的 merged-data / DSL battle / wire 用例 |
| `test/studio/**` | 91 条，70 绿 / 2 跳过 | 全部是 Windows 建符号链接 `EPERM` |
| 根目录 `test/*.test.js` | 1857 条，1822 绿 / 15 跳过 | extract.py 一族、i18n 未包裹、packs 索引、房回收、traffic 的 loopback 判定、`the real build` |

判断一条红是不是自己弄出来的：先看它是否在上面这张表的「剩下的红」里，再不行用 `git worktree add .tmp-base <提交>` + `mklink /J .tmp-base\node_modules node_modules` 在旧提交上跑同一条用例对比。
## 源码与生产包隔离

- `test/helpers/test-setup.js` 只在测试命令中显式预加载，复用现有 `--source-client` 开关；生产服务器启动行为不变。
- 普通测试即使目录里有新旧 `public/build`，首页也固定使用源码。需要 `/js/`、`/sim/` 或源码 vendor 的测试不再混入打包页面。
- 生产包浏览器测试每次在系统临时目录构建，显式 `clientBuild: true`，校验请求的入口与本次 manifest 相符，并拒绝任何源码脚本请求。失败时也关闭浏览器和服务、删除临时产物。
- 不删除、不重建本机 `public/build` 来“修复”测试；`test:client` 不读取或写入这个目录。
- `test/vite.test.js` 原有的构建/模拟一致性用例已经使用独立临时目录，继续保留。CI 与本机 `tools/ci.mjs` 的普通测试入口统一使用 `npm test` 对应的参数；部署冒烟测试仍使用正常生产模式。

定向运行其他源码浏览器测试时保留预加载器，例如（先设置该用例需要的环境变量）：

```sh
node --import ./test/helpers/test-setup.js --test test/ui/utility-mobile.e2e.test.js
```

`node --test` 裸命令不会自动载入本分支测试环境，不作为推荐入口。浏览器测试串行运行，避免多个 Chrome/WebGL 实例争用 CPU 后把测试环境卡顿误判成游戏延迟。
