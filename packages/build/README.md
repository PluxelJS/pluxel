# @pluxel/build

> Status: internal/private toolchain package. It is consumed by Pluxel build flows, not installed as a user-facing runtime package.

`@pluxel/build` 是内部构建辅助包。它只做一件事：把 authoring 源码降成干净、可发布的运行时产物。

如果你要理解插件前端整条链路，不要只看这个 README，直接看：

- [`docs/architecture/frontend.md`](../../docs/architecture/frontend.md)

在前端架构里，`@pluxel/build` 的角色很明确：

- 它不定义 authoring API
- 它不定义 runtime API
- 它只负责把 authoring/HMR 语义静态改写成 runtime 能消费的语义

## 关键插件

- `configSourcePlugin()`
  提取 `@Config(...)` / `configs.use(...)` 的 schema source
- `hmrUiBridgePlugin()`
  把 `ui(...).bind(ctx)` 重写成 `ctx.ext.ui.remote.packaged()`
- `importTypeFixerPlugin()`
  修正装饰器和类构造场景下需要的 type-only import

## 默认 overlay

`@pluxel/build/cli` 的 `cliTsdownOverlay` 默认包含：

- `importTypeFixerPlugin()`
- `configSourcePlugin()`
- `hmrUiBridgePlugin()`

目标是让最终产物不再残留 authoring/HMR 语义。

对插件前端来说，最关键的就是这一步：

- 源码里允许写 `ui(...).bind(ctx)`
- 最终产物里只应该剩下 `ctx.ext.ui.remote.packaged()`

这样 runtime 才不会反向依赖 HMR authoring bridge。

## 插件前端构建约定

在当前前端链路里，`@pluxel/build` 需要和 `@pluxel/hmr/plugin-build` 保持同一套固定约定：

- 作者侧源码允许写 `ui(...).bind(ctx)`
- build 期必须把这层 bridge rewrite 掉
- 插件 UI remote 由 MF2 产出
- 如果插件包根目录存在 `project.inlang`，插件 UI 子编译会按固定路径接入 Paraglide

固定约定如下：

- Paraglide project file：`project.inlang`
- 消息目录：`messages/`
- 生成目录：`src/paraglide/`

这些路径现在应该理解成 build contract，而不是“建议可以自行修改”的配置。

## 用法

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

## 约束

- rewrite 必须是静态可判定的
- 最终发布产物不能依赖内部 workspace 包
- parser 主路径依赖 bundler 的 `this.parse`
- `oxc-parser` 主要用于测试校验
