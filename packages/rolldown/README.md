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
- `workbenchUiBuildPlugin`：静态提取纯 `workbench.entry(import.meta.url, path)` declaration，增量构建并
  原子发布 per-owner federation artifact；无 UI 时不加载 Vite。

工具链不包含公开 API bridge 或兼容 rewrite。
