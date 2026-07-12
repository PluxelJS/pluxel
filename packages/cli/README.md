# @pluxel/cli

Pluxel CLI（对外发布包之一）。

它是用户侧的命令入口，自身不定义 runtime、HMR 或构建协议。命令实现按需加载，未使用的能力不要求安装，也不会在 `pluxel --help` 或 `pluxel new` 时初始化。

如果你在追：

- runtime / loader HMR / build 的总边界：看 `docs/RUNTIME.md`、`docs/HMR.md`、`docs/TOOLCHAIN.md`
- 插件前端链路：看 `docs/FRONTEND.md`
- 发布与内联约束：看 `docs/GOVERNANCE.md`

常用：

```sh
pluxel build
pluxel hmr
pluxel new
```

`pluxel new` 当前提供两条主路径：

- `plugin`：在已有 workspace 中创建可发布插件包。
- `app-monorepo`：创建独立的 static host、示例插件和纯领域包，适合新业务仓库。

新产品优先使用：

```sh
pluxel new --template app-monorepo --name @acme/my-app
```

维护者可运行 `pnpm --filter @pluxel/cli test:templates`。该检查会打包当前 workspace 的
Pluxel 发布包，在仓库外分别生成 standalone plugin 和 app monorepo，并完成独立安装、lint、
typecheck、test、build 和 package smoke。

只使用 `pluxel new` 不需要安装其他 Pluxel runtime 或 toolchain 包。按命令安装可选能力：

```sh
# pluxel build / pluxel workspace
pnpm add -D @pluxel/rolldown tsdown oxlint

# pluxel hmr
pnpm add -D @pluxel/runtime-dynamic
```

`pluxel publish` 的 npm 发布流程不依赖 market SDK；需要 market webhook 时再安装 `@pluxel/market`。

CLI 不再转发其他包的 library API。代码应直接从能力所有者导入：

```ts
import { resolveBuildContext } from '@pluxel/rolldown/build'
import { diagnoseLoaderHmrWorkspace } from '@pluxel/runtime-dynamic/hmr/diagnose'
```

## 在前端链路里的角色

对插件前端来说，CLI 主要负责两件事：

- `pluxel hmr`
  提供 loader HMR workspace profile 的诊断、TUI 编辑和辅助索引
- `pluxel build`
  走 `@pluxel/rolldown` 的默认 overlay，把 authoring/hmr 语义降成 runtime 可消费的产物

也就是说，CLI 是命令入口，不是前端架构本身的一层。

## 怎么理解这个包

可以把 CLI 当成一个很薄的 orchestration layer：

- `pluxel hmr`
  组装无 runtime 注册副作用的 `@pluxel/runtime-dynamic/hmr/diagnose`
- `pluxel build`
  组装 `@pluxel/rolldown` + 相关 build helper
- `pluxel new`
  组装脚手架能力

因此 CLI 文档只回答“命令把哪些能力串起来”，不会重新定义 runtime/loader-hmr/build 的架构边界。

## Loader HMR 边界

CLI 不拥有 loader HMR 的发现和路径规则。

归 `@pluxel/runtime-dynamic/hmr/diagnose`：

- loader HMR config 读写和严格校验
- profile merge
- workspace package scan
- plugin discovery
- dependency closure / `watchRoots`
- `LoaderHmrWorkspace` snapshot build

dynamic route 启动、module replacement 和 runtime service 注册仍归 `@pluxel/runtime-dynamic/hmr` 及其内部实现，不由 CLI diagnostics 入口加载。

归 CLI：

- 参数解析
- TUI 编辑
- 输出 `pluxel.loader.hmr.discovered.jsonc` 这类辅助索引
- 调用 side-effect-free diagnostics API 生成/诊断 profile 数据

这样 `pluxel hmr` 可以保持用户入口集中在 CLI，但 monorepo HMR、路径归一化和 workspace discovery 的正确性仍由 runtime-dynamic 这个领域包负责。
