# 本分支测试流程

## 入口

```sh
npm test                                    # 单元/集成测试，最多 4 个测试进程
node --import ./test/helpers/test-setup.js --test test/test-workflow.test.js test/ci.test.js
npm run test:browser                         # 源码 CDN / 离线资源浏览器回归，串行
npm run test:client                          # 临时构建生产包，验证启动与进入大厅
```

`npm test` 显式发现 `test/**/*.test.js` 与 `test/**/*.test.mjs`。不要改成无路径参数的裸 `node --test`：`test/fixtures/` 含有导入安全测试用的恶意脚本样本，递归发现会把样本直接执行。

浏览器入口自动设置测试开关并查找常见安装路径；找不到 Chrome 时会失败，请设置 `CHROME_PATH`。CDN 美术测试需要本机已下载的素材和 `.assets-manifest.json`，缺少时对应素材用例会跳过。离线资源测试使用临时假素材。

## 环境相关用例

浏览器用例需要 Chrome；素材端到端用例还需要本地素材。部分提取、符号链接和只读目录用例受操作系统与运行权限影响，以本次运行给出的 skip/fail 和条件为准，不使用旧机器的计数作为当前基线。

性能用例（`test/sim/robustness.test.js` 的 boss field）测量每 tick CPU 时间（`process.cpuUsage`），不是墙钟时间。并行测试时墙钟包含等待 CPU 的时间；遇到边界失败时应在相同条件下复跑，并按用例头部的说明判断。

## 源码与生产包隔离

- `test/helpers/test-setup.js` 只在测试命令中显式预加载，复用 `--source-client` 开关；生产服务器启动行为不变。
- 普通测试即使目录里有新旧 `public/build`，首页也固定使用源码。需要 `/js/`、`/sim/` 或源码 vendor 的测试不会混入打包页面。
- 生产包浏览器测试每次在系统临时目录构建，显式 `clientBuild: true`，校验请求入口与本次 manifest 相符，并拒绝源码脚本请求。失败时也关闭浏览器和服务、删除临时产物。
- 不删除或重建本机 `public/build` 来“修复”测试；`test:client` 不读取或写入这个目录。
- `test/vite.test.js` 的构建/模拟一致性用例使用独立临时目录。CI 与 `tools/ci.mjs` 的测试入口统一调用 `npm test`；部署冒烟测试仍使用正常生产模式。
