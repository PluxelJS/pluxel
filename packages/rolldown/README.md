# @pluxel/rolldown

Rolldown/Vite 工具链入口：

- `configSourcePlugin`：生成 config metadata，并从 `@pluxel/runtime/toolchain` 导入 helper。
- `lintGuardPlugin`：执行插件声明约束检查。
- UI build utilities：将纯 `ui()` declaration 的入口构建为 federation artifact。

工具链不包含公开 API bridge 或兼容 rewrite。
