# @pluxel/rolldown

Rolldown/Vite 工具链入口：

- `@pluxel/rolldown/build`：`pluginPackage()` 与 `staticApplication()` 通过 tsdown 驱动 Rolldown，并组合同一个
  `createPluginBuildPipeline()`，统一 decorator metadata、preprocessor/macro、lint、config metadata、Workbench
  source transform、optional plugin semantic policy 和输出检查。`pluginPackage()` 的单次 semantic pass 同时生成幂等的
  `pluxel.pluginPackages` 与 peer metadata，并从第一次构建起保持 detected required/optional provider external；
  static application 使用 bundle-or-absent。CLI 不追加 import tracker。
- `@pluxel/rolldown/vite`：提供同语义的 Vite source adapter，供 static/dynamic ModuleRunner 和 HMR route 复用。
- `configSourcePlugin`：生成 config metadata，并从 `@pluxel/runtime/toolchain` 导入 helper。
- `lintGuardPlugin`：执行插件声明约束检查。
- `pluginArtifactBuildPlugin`：在同一次 transform 中提取 Workbench UI 与 `defineNodeModule()` declaration，
  分别增量构建并原子发布 browser Federation remote 和单文件 Node ESM；无 declaration 时不加载 target builder。

工具链不包含公开 API bridge 或兼容 rewrite。
