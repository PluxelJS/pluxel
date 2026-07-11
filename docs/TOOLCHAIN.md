# Toolchain

Pluxel 插件源码通过 Vite/Rolldown 链执行和构建。工具链负责提供 runtime 所依赖的静态事实，不改变作者模型。

## 职责

- OXC legacy decorator transform 与 `design:paramtypes`；
- config source、binding、layout 和 feature metadata；
- plugin UI federation artifact；
- lint guard 与构建边界检查；
- Vite Module Runner、source conditions 和 singleton resolution。

## 非职责

- 不注入第二套 dependency 或 UI API；
- 不让 toolchain helper 出现在默认作者入口；
- 不替代 core graph/lifecycle；
- 不在 Web Management disabled 时创建 UI compiler 或 watcher。

Node 原生 type stripping 可运行普通代码生成脚本，但不会生成 Pluxel decorator metadata，因此不是插件源码入口。

## 关键入口

- `packages/runtime-dev/src/vite.ts`
- `packages/rolldown/src/rolldown/plugins/configSourcePlugin.ts`
- `packages/rolldown/src/rolldown/plugins/lintGuardPlugin.ts`
- `packages/rolldown/src/workspace/oxlint/`
- `packages/test/src/vitest.ts`

工具链契约必须由真实 Vite Module Runner 测试验证，不能用 raw TypeScript runner 的行为推断。
