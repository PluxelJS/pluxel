# Config Architecture

配置链分成声明/校验与宿主持久化两层：

```text
core: schema declaration -> defaults -> validation -> normalized snapshot
runtime: profile -> persistence/watch -> patch/reset -> workbench read model
```

## 不变量

- 默认值属于 schema；runtime 和插件不重复 fallback。
- `configs.use()` 与 `cfg(schemaMap)` 是作者声明。
- 配置在实例构造后、`init()` 前注入；constructor 不读取配置值。
- config metadata 是 build-time 数据，不是 runtime AST 推断。
- core validation 不依赖文件系统或 Workbench Plane。

## Toolchain metadata

`configSourcePlugin()` 提取 schema source、binding 和 layout，生成代码通过 `@pluxel/runtime/toolchain` 写入 definition metadata。该 subpath 不是作者 API。

runtime 将 metadata 投影为宿主需要的 schema、defaults 和 layout。Workbench Plane 只是其中一个消费者，不拥有配置事实。

## 实现入口

- `packages/core/src/services/config/`
- `packages/core/src/plugins/composition/ConfigHost.ts`
- `packages/core/src/plugins/composition/cfg.ts`
- `packages/runtime/src/services/ConfigService.ts`
- `packages/runtime/src/api/usecases/pluginConfig.ts`
- `packages/rolldown/src/rolldown/plugins/configSourcePlugin.ts`
- `packages/runtime/docs/config/contract.md`

作者用法见 [`user-docs/plugin-authoring.md`](../user-docs/plugin-authoring.md#配置声明一次只读取归一化结果)。
