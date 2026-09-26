# `@pluxel/package-manager`

为 dynamic host 管理 pnpm project，并原子发布插件 source entries。

本包为 workspace 内部预览，不是仓库外项目的安装入口。

宿主 catalog 需要 PackageManagerPlugin；业务插件通过 constructor 注入直接使用的能力。

- [用法、配置与验证](../../docs/plugins/package-manager.md)
- [维护约束](DESIGN.md)

维护时用 `PLUXEL_PNPM_NATIVE_INTEGRATION=1 pnpm --filter @pluxel/package-manager test` 验证真实 registry install → entry publish → remove。
