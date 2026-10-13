# 本分支测试流程

## 三个入口

```sh
npm test                                    # 单元/集成测试，最多 4 个测试进程
npm test -- test/test-workflow.test.js test/ci.test.js
npm run test:browser                         # 源码 CDN / 离线资源浏览器回归，串行
npm run test:client                          # 临时构建生产包，验证启动与进入大厅
```

浏览器入口自动设置所需的测试开关，查找常见安装路径；找不到 Chrome 时明确失败，请设置 `CHROME_PATH`。CDN 美术测试仍需要本机已下载的素材和 `.assets-manifest.json`，缺失时只跳过该素材用例。离线资源使用临时假素材，不依赖官方资源。

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
