# `@pluxel/plugin-package-manager`

在 Node 宿主中通过市场或应用配置的 npm registry 查找插件，用 pnpm 准备安装，再发布审阅过的插件入口。原生启动时扫描来源，托管 Vite 可以在线接纳新入口。

本包为 workspace 内部预览，不是仓库外项目的安装入口。

宿主 catalog 需要 PackageManagerPlugin；业务插件通过 constructor 注入直接使用的能力。

- [用法、配置与验证](../../docs/plugins/package-manager.md)
- [插件市场设计](../../engineering/PLUGIN_MARKET.md)
- [安装记录与失败恢复](DESIGN.md)
- [跨平台插件交付](../../docs/host/runtime-portability.md#开发与交付)
- [独立 Worker 市场](../../projects/plugin-market/README.md)

维护时用 `PLUXEL_PNPM_NATIVE_INTEGRATION=1 vp run @pluxel/plugin-package-manager#check-tests` 验证原生 registry 拒绝普通 npm 库，以及受管入口在新宿主进程中的发布和撤回。
