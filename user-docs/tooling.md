# CLI 与工具链

`@pluxel/cli` 是按命令加载的编排入口，不是 runtime 或构建 API 的聚合包。

插件写法、最佳实践和 Pluxel 增补 lint rules 分别见
[`plugin-authoring.md`](plugin-authoring.md)、
[`plugin-best-practices.md`](plugin-best-practices.md) 和 [`oxlint.md`](oxlint.md)。本页只说明命令
和 package ownership。

只创建项目时安装 CLI 即可：

```sh
pnpm add -D @pluxel/cli
pluxel new
```

按使用的命令补充能力：

```sh
# 构建无 UI 插件或管理 workspace
pnpm add -D @pluxel/rolldown tsdown oxlint

# 只有声明 Workbench UI 的插件包需要
pnpm add -D vite

# 编辑和诊断 dynamic loader HMR profile
pnpm add -D @pluxel/runtime-dynamic
```

缺少可选包时只禁用对应命令，不影响根帮助和脚手架。

代码中不要从 CLI 导入 build、Rolldown 或 HMR API，应直接使用所有者入口：

```ts
import { resolveBuildContext } from '@pluxel/rolldown/build'
import { diagnoseLoaderHmrWorkspace } from '@pluxel/runtime-dynamic/hmr/diagnose'
```

`hmr/diagnose` 只处理配置、workspace discovery、profile 和 snapshot，不注册 dynamic runtime services。

`pluxel build` 通过 `@pluxel/rolldown/build` 的标准 `pluginPackage()` preset 调用 tsdown/Rolldown。该 preset 与
static application build 复用同一 source pipeline，统一执行 legacy decorator 与 constructor metadata、
preprocessor/macro、config metadata、lint、Workbench declaration transform 和输出检查，不依赖项目是否在 tsconfig
中重复声明这些 bundler 语义。普通插件仍把 Pluxel runtime 保持为 peer dependency，不会变成 static application
bundle。

`pluxel build` 从 server-only `workbench.extension()` 静态提取
`workbench.entry(import.meta.url, './ui/index.tsx')`。无 UI declaration 时不会加载 Vite/MF；有 UI 时 server
bundle 与 `dist/workbench/<artifact>/` remote 分开生成。toolchain 按 declaration 与 source graph 注入稳定
artifact key，不要求 Extension 重复 plugin ID。完整 remote 缓存在
`.pluxel/workbench-build/<artifact>/<hash>/`，因此 tsdown 清空 `dist` 后仍可复用；缓存命中不会加载完整
Vite/MF builder，依赖 lockfile 变化则自动失效。可安全删除该目录执行冷构建。

同一进程可同时发现、计算和命中多个插件 UI 缓存；Pluxel 会在底座隔离实际 Federation builder，并按
输出目录串行校验与原子发布。项目无需为多个 Workbench UI 设置 `compileConcurrency: 1`，也不要自行共享
临时输出目录。
