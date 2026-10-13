# 数据插件模板

复制此目录到 `plugins/data-demo/`。清单中的文件夹 id 与记录命名空间对应（`data-demo` → `data_demo`）；改名时一起改记录 id。

`data/bond.json` 把助力的基础防御加成改为 30%。`operators/guard.json` 添加普通/精锐演示守卫，并加入自选池；复用角峰的官方 kit，数值由此文件提供。素材只引用本安装已有的角峰，无官方素材文件。

P1b 提供构建 API；房间开关和加载这些组合由 P1c 接入。格式和错误见 `docs/PLUGINS.md` §10。
