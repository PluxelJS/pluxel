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

- `packages/runtime-dynamic/src/hmr/`
- `packages/runtime-static/src/hmr.ts`
- `packages/runtime-static/src/vite.ts`
- `packages/runtime-dev/src/vite.ts`
- `packages/runtime-dev/src/extensions/ExtensionCompilerService.ts`
