# @pluxel/cli

Pluxel CLI（对外发布包之一）。

它是用户侧的入口（build / scaffold / HMR 等命令），自身不定义 runtime 或前端协议，只负责把已有能力组织成命令行体验。

如果你在追：

- runtime / loader HMR / build 的总边界：看 `docs/RUNTIME.md`、`docs/HMR.md`、`docs/TOOLCHAIN.md`
- 插件前端链路：看 `docs/FRONTEND.md`
- 发布与内联约束：看 `docs/GOVERNANCE.md`

文档入口：

- `docs/OPS.md`
- `docs/TOOLCHAIN.md`
- `docs/GOVERNANCE.md`
- `docs/proposals/README.md`

常用：

```sh
pluxel build
pluxel hmr
pluxel new
```

对外使用 `pluxel build` / `@pluxel/cli/build` 时，项目应自行安装：

- `tsdown`
- `oxlint`

## 在前端链路里的角色

对插件前端来说，CLI 主要负责两件事：

- `pluxel hmr`
  启动 `@pluxel/runtime-dynamic/hmr` host，让 `ui(...).bind(ctx)` 这类 authoring bridge 在开发期生效
- `pluxel build`
  走 `@pluxel/build` 的默认 overlay，把 authoring/hmr 语义降成 runtime 可消费的产物

也就是说，CLI 是命令入口，不是前端架构本身的一层。

## 怎么理解这个包

可以把 CLI 当成一个很薄的 orchestration layer：

- `pluxel hmr`
  组装 `@pluxel/runtime-dynamic/hmr`
- `pluxel build`
  组装 `@pluxel/build` + 相关 build helper
- `pluxel new`
  组装脚手架能力

因此 CLI 文档只回答“命令把哪些能力串起来”，不会重新定义 runtime/loader-hmr/build 的架构边界。

## Loader HMR 边界

CLI 不拥有 loader HMR 的发现和路径规则。

归 `@pluxel/runtime-dynamic/hmr`：

- loader HMR config 读写和严格校验
- profile merge
- workspace package scan
- plugin discovery
- dependency closure / `watchRoots`
- `LoaderHmrWorkspace` snapshot build
- host create/install

归 CLI：

- 参数解析
- TUI 编辑
- 输出 `pluxel.loader.hmr.discovered.jsonc` 这类辅助索引
- 调用 runtime-dynamic 的 headless API 后启动 host

这样 `pluxel hmr` 可以保持用户入口集中在 CLI，但 monorepo HMR、路径归一化和 workspace discovery 的正确性仍由 runtime-dynamic 这个领域包负责。
