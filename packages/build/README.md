# @pluxel/build (internal)

`@pluxel/build` 是 Pluxel 内部 build helper 包，供 `@pluxel/cli` 和 `@pluxel/hmr` 使用。

它的目标只有一个：把 authoring 源码稳定降级成干净的运行时产物。

## 关键插件

`@pluxel/build/rolldown` 导出几类核心插件：

- `configSourcePlugin`
  - 提取 `@Config(...)` 和 `configs.use(...)` 的 schema source
- `hmrUiBridgePlugin`
  - 把 `ui(...).bind(ctx)` 重写成 `ctx.ext.ui.packaged()`
  - 只接受 `@pluxel/hmr/plugin` 的 named import，保证 rewrite 可判定
- `importTypeFixerPlugin`
  - 修正 `@Plugin` 类构造参数需要的 type-only import

其余工具主要用于 `.d.ts` 重写、bundle 守卫和 import 跟踪。

## CLI overlay

`@pluxel/build/cli` 里的 `cliTsdownOverlay` 是默认插件构建基线，包含：

- `importTypeFixerPlugin()`
- `configSourcePlugin()`
- `hmrUiBridgePlugin()`

目标是让最终产物不再残留 authoring/HMR 语义。

## Usage

```ts
import {
	configSourcePlugin,
	hmrUiBridgePlugin,
	importTypeFixerPlugin,
} from '@pluxel/build/rolldown'

export default {
	plugins: [importTypeFixerPlugin(), configSourcePlugin(), hmrUiBridgePlugin()],
}
```

```ts
import { cliTsdownOverlay } from '@pluxel/build/cli'

export default cliTsdownOverlay
```

## Notes

- parser 能力来自 bundler 的 `this.parse`
- `oxc-parser` 只在测试里做 AST 校验
- 最终发布产物不能要求用户安装内部 workspace 包
