# Config Architecture

配置链分成声明/校验与宿主持久化两层：

```text
core: schema declaration -> defaults -> validation -> normalized snapshot
runtime: core engine subclass -> persistence -> patch/reset -> workbench read model
```

## 不变量

- 默认值属于 schema；runtime 和插件不重复 fallback。
- `configs.use()` 与 `cfg(schemaMap)` 是作者声明。
- 配置在实例构造后、`init()` 前注入；constructor 不读取配置值。
- config metadata 是 build-time 数据，不是 runtime AST 推断。
- core validation 不依赖文件系统或 Workbench Plane。
- raw record、revision 与 validation cache 只有 core `ConfigService` 一份；runtime 子类只增加持久化策略。
- static application build 固定的是 plugin code graph 和 `configure()` resolver code，不是 resolver 的启动返回值。

## Static startup config

`defineStaticRuntime({ configure(startup) {} })` 将固定 catalog 与启动值分开。`startup` 提供 mode、env、platform bindings
和 deployment facts；resolver 每次 host startup 重新执行，可选择 persistence、ConfigService、RuntimeState、HTTP、
logging、profile 和 Workbench policy。

插件的 config records 与 enabled state 继续由 ConfigService/RuntimeState 管理，可以在 fixed catalog 范围内修改并跨
启动持久化。production bundle 不把这些记录烘焙成不可变常量。

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
