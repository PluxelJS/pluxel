# HMR

HMR 是 route 和 Vite 的实现能力，不进入插件作者 API。

## 不变量

- source module 由 Vite Module Runner 执行；
- module update 转换为 core replacement/commit；
- provider replacement 后 optional plugin integration 重新绑定；
- effects scope 清理旧实例资源；
- config 或 UI source watcher 只在对应能力启用时存在；
- HMR 不能绕过 graph verification 或直接修改 running instance。

static route reload fixed definition；dynamic route 额外拥有 scan、loader 和 module catalog。两者复用同一 core lifecycle。

## 实现入口

- `@pluxel/runtime-dynamic/hmr/diagnose`：无 runtime 注册副作用的 config、workspace scan、profile 和 snapshot API；
- `@pluxel/runtime-dynamic/hmr`：dynamic route HMR engine 和 runtime integration；
- `packages/runtime-dynamic/src/hmr/`
- `packages/runtime-static/src/hmr.ts`
- `packages/runtime-static/src/vite.ts`
- `packages/runtime-dev/src/vite.ts`
- `packages/runtime-dev/src/extensions/ExtensionCompilerService.ts`

CLI 和其他离线工具只能使用 diagnostics 入口。读取或编辑 HMR 配置不得触发 runtime service 注册。
