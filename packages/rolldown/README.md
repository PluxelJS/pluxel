# @pluxel/rolldown

Rolldown/Vite 工具链入口：

该包不提供 root 或 `./workspace` 聚合入口；按实际能力导入下面的明确 subpath，避免加载无关工具链。

- `@pluxel/rolldown/build`：`pluginPackage()` 与 `staticApplication()` 通过 tsdown 驱动 Rolldown，并组合同一个
  `createPluginBuildPipeline()`，统一 Plugin definition lowering、preprocessor/macro、lint、单 ObjectSchema config facts、
  Workbench source transform 和输出检查。`pluginPackage()` 的单次 semantic pass 验证 package-root named export，提取
  constructor required edge 与 `definePluginRef<T>()` optional edge，并生成幂等的 `pluxel.pluginPackages` / peer metadata。
  required 与 optional provider 都保持 external；type-only optional ref 不解析、加载或合成 absent module，也没有 reflection
  metadata/name fallback。CLI 不追加并行 import tracker。
- `@pluxel/rolldown/vite`：提供同语义的 Vite source adapter，供 static/dynamic ModuleRunner 和 HMR route 复用。
  `pluginSourceVitePlugins()` 与 `pluxelRuntimeSourceVitePlugins()` 支持显式 `sourceSpaces` 映射；配置、`realpath`
  containment 和 identity 边界见
  [`../../docs/development/tooling.md`](../../docs/development/tooling.md#source-build-boundary)。
- `@pluxel/rolldown/distribution`：static artifact-set finalizer、in-toto/DSSE helper、offline verifier 和 inert delivery
  marker；raw v1 schema 位于 `@pluxel/rolldown/distribution/schema.json`。用户流程见
  [`../../docs/development/distribution.md`](../../docs/development/distribution.md)，维护约束见
  [`../../engineering/DISTRIBUTION.md`](../../engineering/DISTRIBUTION.md)。
- `configSourcePlugin`：生成单一 ObjectSchema config metadata，并从 `@pluxel/runtime` 导入 lowering helper。
- `lintGuardPlugin`：执行插件声明约束检查。
- `pluginArtifactBuildPlugin`：在同一次 transform 中提取 Workbench UI 与 `defineNodeModule()` declaration，
  分别增量构建并原子发布 browser Federation remote 和单文件 Node ESM；无 declaration 时不加载 target builder。

工具链不包含公开 API bridge 或兼容 rewrite。
