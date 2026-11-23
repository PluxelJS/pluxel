# `@pluxel/plugin-package-manager`

同一插件提供可选市场浏览、直接 npm 安装与已安装包管理；在 Node 宿主中准备 pnpm 安装并发布插件入口。原生启动时扫描来源，托管 Vite 可以在线接纳新入口。

本包为 workspace 内部预览，不是仓库外项目的安装入口。

宿主 catalog 需要 PackageManagerPlugin；业务插件通过 constructor 注入直接使用的能力。

- [用法、配置与验证](../../docs/plugins/package-manager.md)
- [维护约束](DESIGN.md)
- [跨平台插件交付](../../docs/host/runtime-portability.md#开发与交付)
- [独立 Worker 市场](../../projects/plugin-market/README.md)

维护时用 `PLUXEL_PNPM_NATIVE_INTEGRATION=1 vp run @pluxel/plugin-package-manager#check-tests` 验证真实 registry install → entry publish → remove。
