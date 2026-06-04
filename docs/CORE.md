# Core

`@pluxel/core` 是 Pluxel 的最小插件内核。它负责插件语义本身，而不是宿主能力。

## 设计边界

core 拥有：

- `Context`
- 插件声明和运行实例
- DI graph、feature 依赖和生命周期编排
- `register` / `unregister` / `replace` / `restart` / `commit`
- effects cleanup
- logger、events、core config validation 等基础服务
- 插件配置声明、默认值归一化和校验快照

core 不拥有：

- HTTP、RPC、MCP、SSE
- workspace scan、package install、runtime loader
- web workbench、浏览器协议
- Vite、HMR、构建期源码改写
- 配置文件持久化

这个边界的目的不是让层数变多，而是让插件语义能在没有真实宿主的情况下被测试和复用。企业固定插件目录、动态 loader 目录、测试 host 都应该可以复用 core 的生命周期和配置校验。

## 生命周期模型

core 的生命周期是 commit-based：

```text
draft graph changes
-> commit()
-> graph verify
-> stop/start plan
-> lifecycle execution
-> CommitSummary
```

默认顺序：

- stop：先停 dependents，再停 providers。
- start：先启 providers，再启 dependents。
- 启动失败隔离在失败插件及其相关依赖内，不应让无关插件被误停。
- effects cleanup 跟随插件 lifetime。
- runtime/HMR/workbench 只消费 commit summary，不重新实现生命周期语义。

## Feature 模型

当前稳定基线：

- `features.use(FeatureCtor)`：required feature，属于宿主插件的静态组成。
- `defineOptionalFeature(spec)`：声明 optional feature。
- `features.tryUse(spec)`：条件启用或 lazy load optional feature。
- `features.dep(DepPlugin, cb?)`：运行期 optional integration primitive。
- plugin constructor 只表达 required deps。

不要把 runtime optional 和 link-time optional 混在一起。provider 类型可静态 import 时可以用类 token；provider 包本身可能缺失时用稳定字符串 token，把 provider-specific 代码放到 `load()` 后面。

## Config 在 core 的部分

core 只处理声明和校验：

- `configs.use(schema)`
- `configs.use(cfg(schemaMap))`
- schema defaulting
- validated snapshot
- `ConfigService.ensureValidated(...)`
- defaults/patch validation 纯函数

默认值必须放在 schema 里。`configs.use(...)` 返回的是归一化后的输出，插件代码不应再写 `config ?? defaults` 或自造 fallback 对象。

## 实现入口

- `packages/core/src/index.ts`：core public exports。
- `packages/core/src/plugins/index.ts`：插件系统导出。
- `packages/core/src/services/index.ts`：core services 导出。
- `packages/core/src/plugins/runtime/PluginService.ts`：生命周期 API 和 commit 编排。
- `packages/core/src/plugins/runtime/PluginDefinitions.ts`：draft/active graph 定义。
- `packages/core/src/plugins/runtime/commit.ts`：stop/start plan 与执行。
- `packages/core/src/plugins/runtime/LifecycleManager.ts`：插件生命周期调用。
- `packages/core/src/plugins/runtime/fork.ts`：forked plugin constructor 处理。
- `packages/core/src/plugins/decorators/**`：`@Plugin` metadata 和 decorator runtime。
- `packages/core/src/plugins/composition/**`：`BasePlugin`、`BaseFeature`、config/feature field hosts。
- `packages/core/src/services/config/ConfigService.ts`：core config 校验和归一化快照。
- `packages/core/src/services/config/ops.ts`：config defaults 和 patch 校验 helper。
- `packages/core/src/plugins/composition/cfg.ts`：`cfg(schemaMap)` 和 layout DSL。

## 测试判断

只验证插件生命周期、DI、feature、effects、core config 时，用 core test host。需要 loader、配置持久化、HTTP、runtime services 时，进入 runtime test host。需要 Vite runner/watch/moduleGraph 时，进入 HMR 测试链路。
