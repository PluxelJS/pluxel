# Config

配置能力分成两半：

```text
core      declaration / validation / defaults / normalized snapshots
runtime   persistence / profile / patch-reset ops / web config
```

这个分法让配置声明可移植，同时让 runtime 提供文件落盘、网页配置、profile 和控制面。

## 作者写法

推荐：

- `configs.use(schema)`
- `configs.use(cfg(schemaMap))`
- 默认值写进 Valibot schema。
- `cfg` layout 用 schema key 控制配置页排版。
- `configs.use(...)` 和 `features.use(...)` 放在 module-level class fields。

不推荐：

- 在插件里对 `configs.use(...)` 的返回值再写 `?? defaults`。
- 用 `||` 或 ad hoc fallback object 重做默认值。
- 运行期动态构造 schema key，导致 build/runtime 无法稳定分析。

## core 负责什么

- schema defaulting。
- `ConfigService.ensureValidated(...)`。
- validated snapshot。
- defaults 和 patch validation helper。
- `cfg(schemaMap)` declaration 和 layout DSL。
- config metadata 进入 plugin definition snapshot。

## runtime 负责什么

- file/memory/readonly 配置模式。
- profile-aware config path。
- debounced save。
- disk watch。
- config get/validate/patch/reset operations。
- web/workbench config integration。
- Host/UI 需要的 `plugin.schema()` read model。

## Build metadata flow

构建期 `configSourcePlugin` 只分析启动前静态声明，并注入：

- `__setConfigSource__(Ctor, key, schemaSource)`
- `__registerConfigSchema__(Ctor, key, schema)`
- `__registerConfigBinding__(Ctor, field, keys)`
- `__setConfigLayout__(Ctor, field, layoutParts)`

core 快照把 metadata 组织到 `configSourceMap`、`configBindingsMap`、`configLayoutMap`。runtime 的 `plugin.schema()` 再整理成 Host 真正需要的：

- `schemaSource`
- `defaults`
- `layout`

如果存在多个 layout 绑定，runtime 优先选择覆盖全部 schema keys 的绑定；否则退回确定性的首个绑定。

## layout parts

`BuiltinMarkdownPart` 当前有三种：

- `{ kind: 'md', text }`：静态 markdown。
- `{ kind: 'schema', key }`：渲染单个 schema key。
- `{ kind: 'schemas', keys }`：渲染指定 keys；`keys: null` 表示剩余未放置 keys。

约束：

- 同一个 schema key 不能重复放置。
- `schemas()` 只能出现一次，且必须是最后一个 schema-placement token。

## 实现入口

- `packages/core/src/services/config/ConfigService.ts`：core config validation 和 normalized snapshots。
- `packages/core/src/services/config/ops.ts`：defaults/patch validation helpers。
- `packages/core/src/plugins/composition/cfg.ts`：`cfg(schemaMap)` 和 layout DSL。
- `packages/core/src/plugins/composition/ConfigHost.ts`：config declaration field injection。
- `packages/build/src/rolldown/plugins/configSourcePlugin.ts`：schema/layout source extraction。
- `packages/runtime/src/services/ConfigService.ts`：runtime persistence/profile/watch/debounce。
- `packages/runtime/src/api/ops/plugin-config.ts`：config ops binding。
- `packages/runtime/src/api/features/plugins/**`：plugin config/status read model。
- `packages/runtime/docs/config/contract.md`：runtime 与 Host/UI 的配置实现契约。

## 企业固定插件目录的复用点

即使未来走 runtime-static/fixed catalog，配置仍应复用这条链路：

- static runtime definition 声明插件总量。
- runtime 读取落盘配置并唯一接管 enabled/disabled 状态。
- core 校验 schema/defaults。
- runtime 投影 web config 和 ops。
- 启动时生成 strict startup report，明确哪个插件因配置或依赖没启动。
