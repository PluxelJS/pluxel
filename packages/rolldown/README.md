# @pluxel/rolldown

Rolldown/Vite 工具链入口：

- `configSourcePlugin`：生成 config metadata，并从 `@pluxel/runtime/toolchain` 导入 helper。
- `lintGuardPlugin`：执行插件声明约束检查。
- `managementUiBuildPlugin`：静态提取纯 `managementUi(import.meta.url, path)` declaration，增量构建并
  原子发布 per-owner federation artifact；无 UI 时不加载 Vite。

工具链不包含公开 API bridge 或兼容 rewrite。
