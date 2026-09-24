# @pluxel/rolldown

Rolldown/Vite 工具链入口：

应用通过 root 入口的 `pluxel()` 接入普通 tsdown `plugins` 列表；Plugin package 与其他工具使用对应 subpath。

- `@pluxel/rolldown/inspect`：通过 `openProject()` 查询 workspace/package 的公开插件、Part 组成、config 声明位置、依赖来源和 package scripts；通过 `plugin()` 的 `application` 与 `inputs` 定位源码插件和应用配置输入；不执行项目模块。使用方法与完整性边界见[源码查询](../../docs/development/inspection.md)。

- `@pluxel/rolldown` 的 `pluxel()` 与 `@pluxel/rolldown/build` 的 `pluginPackage()` 通过 tsdown 驱动 Rolldown，并组合同一个
  `createPluginBuildPipeline()`，统一 Plugin definition lowering、preprocessor/macro、lint、单 ObjectSchema config facts、
  Workbench source transform 和输出检查。`pluginPackage()` 的单次 semantic pass 验证 package-root named export，提取
  constructor required edge 与 `definePluginRef<T>()` optional edge，并生成幂等的 `pluxel.pluginPackages` / peer metadata。
  required 与 optional provider 都保持 external；type-only optional ref 不解析、加载或合成 absent module，也没有 reflection
  metadata/name fallback。CLI 不追加并行 import tracker。`pluxel()` 还把 Elysia 当前全部公开 subpath 解析到
  Runtime-owned singleton，并在用户 module 求值前通过 Elysia 的公开 `setupTypebox()` 安装完整 TypeBox runtime namespace，
  使 schema-backed frozen distribution 搬离 source workspace 后仍可编译。
- `@pluxel/rolldown/vite`：提供同语义的 Vite source adapter，供 static/dynamic ModuleRunner 和 HMR route 复用。
  `pluginSourceVitePlugins()` 与 `createPluginSourceVitePipeline()` 支持显式 `sourceSpaces` 映射；配置、`realpath`
  containment 和 identity 边界见
  [`../../docs/development/tooling.md`](../../docs/development/tooling.md#source-build-boundary)。
  Route 必须在 `beginArtifactGeneration().run(...)` 中完成候选 transform、evaluation 与分类，只在候选被接纳后
  `commit()`；`rollback()` 只丢弃该异步 scope 内的候选事实。并发但不在该 scope 内的 ambient transform
  保持独立 authority，commit 不会覆盖 generation 开始后已更新的同 module 事实。
  通用 Vite source adapter 始终让主 watcher 忽略 `.pluxel`；确实消费 generated source 的 runtime route 必须自己只为
  明确声明的 root 建补充 watcher，并继续执行精确 file 或正向 include filter 准入。
- `@pluxel/rolldown/distribution`：static artifact-set finalizer、in-toto/DSSE helper、offline verifier 和 inert delivery
  marker；raw v1 schema 位于 `@pluxel/rolldown/distribution/schema.json`。用户流程见
  [`../../docs/development/distribution.md`](../../docs/development/distribution.md)，维护约束见
  [`../../engineering/DISTRIBUTION.md`](../../engineering/DISTRIBUTION.md)。
- `configSourcePlugin`：生成单一 ObjectSchema config metadata，并从 `@pluxel/core/toolchain` 导入 lowering helper。
- `lintGuardPlugin`：执行插件声明约束检查。
- `pluginArtifactBuildPlugin`：在同一次 transform 中提取 Workbench UI 与 `defineNodeModule()` declaration，
  分别增量构建并原子发布 browser Federation remote 和单文件 Node ESM；无 declaration 时不加载 target builder。

工具链不包含公开 API bridge 或兼容 rewrite。

应用入口使用 `defineHostApplication(factory)`（来自 `@pluxel/host`）。生产构建只读取静态插件目录和 `envBindings`，
从 `envBinding(Plugin, { config: { schema, mapping }, vault: { schema, mapping } })` 显式引用的 schema 生成 `.env.example`，不会执行工厂、读取环境值或打开 `fileBindings` 文件。
环境映射直接使用 `{ plugin: MyPlugin, config: { endpoint: 'APP_ENDPOINT' }, vault: { token: 'APP_TOKEN' } }`；
秘密文件只在实际 Host 启动时读取，不进入构建产物。完整约束见 [Host 配置](../../docs/getting-started/host-setup.md)。
