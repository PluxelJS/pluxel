# `@pluxel/plugin-package-manager`

同一插件提供可选市场浏览、直接 npm 安装与已安装包管理；为 Native/Vite 应用准备 pnpm 安装，再确认发布插件 source entries。

本包为 workspace 内部预览，不是仓库外项目的安装入口。

宿主 catalog 需要 PackageManagerPlugin；业务插件通过 constructor 注入直接使用的能力。

- [用法、配置与验证](../../docs/plugins/package-manager.md)
- [维护约束](DESIGN.md)
- [独立 Worker 市场](../../projects/plugin-market/README.md)

维护时用 `PLUXEL_PNPM_NATIVE_INTEGRATION=1 vp run @pluxel/plugin-package-manager#check-tests` 验证真实 registry install → entry publish → remove。
