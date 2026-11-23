# Electron 主进程宿主

Electron 主进程从 `@pluxel/host` 根入口启动 Pluxel Node Host，窗口展示共用插件的验收回执，以及桌面插件通过 `ctx.service(DesktopApp)` 读取的应用名称和版本。Electron `app` 由主进程持有。渲染器只显示回执，保留 BrowserWindow 默认的沙箱和上下文隔离。 [应用入口](index.js) · [桌面插件](src/index.ts)

## 启动

从仓库根目录运行以下命令。构建会编译共用验收插件和桌面插件。

```sh
vp install
cd projects/host-electron
vp run build
vp run start
```

关闭窗口或退出应用后，主进程释放脚本作用域并等待 Host 关闭。回执中的 HTTP 来源来自示例显式提供的 Fetch 终端，Vault 使用公开的测试绑定，文件和状态使用默认的内存后端。应用启用了 Core 的 LogTape 控制台预设，可以在启动终端看到插件发出的 `Checking host capabilities`。 [共用验收插件](../host-targets/plugins)

将本目录复制到另一个项目时，先把共用验收插件打成 tarball 并在新项目安装。将本项目清单中的 `workspace:` 和 `catalog:` 依赖替换为对应版本或本地包。Vite 和 TypeScript 配置均位于本目录。 [共用插件打包命令](../host-targets/README.md#在其他宿主验收内建能力)

共享插件可在三端示例的 Node + Vite 开发入口联调。这里的 Electron 主进程直接运行已构建的包，原生服务和窗口交接在 Electron 内验收。 [编辑插件并观察 HMR](../host-targets/README.md#本地开发)

## 自动验收

在有图形会话的机器上运行 `vp run test:smoke`，或在提供 Xvfb 的 Linux CI 中运行 `xvfb-run -a vp run test:smoke`。命令启动真实 Electron 窗口，将渲染器显示的内容与主进程回执逐项比较，通过后输出 JSON 并退出。启动、插件调用或窗口验收失败会以非零状态退出。
