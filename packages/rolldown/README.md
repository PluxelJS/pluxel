# @pluxel/rolldown

Rolldown/Vite 工具链入口：

- `@pluxel/rolldown/build`：通过 tsdown 驱动 Rolldown；普通插件 build 与 static application freezer 共用
  decorator metadata、preprocessor/macro、lint、config metadata 和 Workbench source transform。
- `configSourcePlugin`：生成 config metadata，并从 `@pluxel/runtime/toolchain` 导入 helper。
- `lintGuardPlugin`：执行插件声明约束检查。
- `workbenchUiBuildPlugin`：静态提取纯 `workbench.entry(import.meta.url, path)` declaration，增量构建并
  原子发布 per-owner federation artifact；无 UI 时不加载 Vite。

工具链不包含公开 API bridge 或兼容 rewrite。
