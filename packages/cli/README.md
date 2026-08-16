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
pluxel source doctor
pluxel distribution inspect ./dist
```

`pluxel new` 当前提供两条主路径：

- `plugin`：在已有 workspace 中创建可发布插件包。
- `app-monorepo`：创建独立的 static host、示例插件和纯领域包，适合新业务仓库。

两个内置模板都以 pnpm catalog/workspace 为唯一包管理契约，因此固定使用 pnpm 11；自定义模板仍可
使用 `--pm` 选择自己的安装器。非交互调用使用模板显式声明的 prompt default，模板缺少 default 时
直接失败，不在 CI 中等待输入。

`user-docs/` 是插件作者文档的唯一真源。CLI build 将它原样打包到 `dist/user-docs/`；
`app-monorepo` 只声明目标目录，`pluxel new` 会把当前 CLI 版本携带的完整文档递归复制到生成仓库的
`docs/pluxel/`。模板不维护改写版 Markdown，也不对文档执行 Handlebars 渲染。生成的 workspace
默认安装 Turborepo，以全 CPU 并发和本地缓存编排 build、test、typecheck；`verify` 在一个任务图中
复用这些结果。

新产品优先使用：

```sh
pluxel new --template app-monorepo --name @acme/my-app
```

维护者可运行 `pnpm --filter @pluxel/cli test:templates`。该检查会计算并打包当前 workspace 的本地
发布依赖闭包，安装生成的 CLI tarball，再通过其中的 `pluxel new` 在仓库外分别生成 standalone
plugin 和 app monorepo，并完成独立安装、lint、typecheck、test、build 和 package smoke。测试不会
绕过 npm pack，因此也覆盖模板 dotfile 和 bundled user docs。

只使用 `pluxel new` 不需要安装其他 Pluxel runtime 或 toolchain 包。按命令安装可选能力：

```sh
# pluxel build / pluxel workspace
pnpm add -D @pluxel/rolldown tsdown oxlint

# pluxel distribution
pnpm add -D @pluxel/rolldown

# pluxel hmr
pnpm add -D @pluxel/runtime-dynamic
```

`pluxel publish` 的 npm 发布流程不依赖 market SDK；需要 market webhook 时再安装 `@pluxel/market`。

多个独立 pnpm 仓库共同修改未发布源码时使用 `pluxel source register/doctor/install/build`。项目提交
`pluxel.sources.jsonc` 中的仓库身份，机器路径只进入用户 checkout registry；CLI 从真实 package 依赖
推导 override 和构建闭包，并让 lockfile 只记录 `.pluxel/sources/<repository-hash>/<package-slug>-<package-hash>`
package-level 稳定代理路径。完整
用法见打包的 `user-docs/development/source-workspaces.md`。

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
  走 `@pluxel/rolldown/build` 的 `pluginPackage()` preset，把 authoring/HMR 语义降成 runtime 可消费的产物

也就是说，CLI 是命令入口，不是前端架构本身的一层。

## 怎么理解这个包

可以把 CLI 当成一个很薄的 orchestration layer：

- `pluxel hmr`
  组装无 runtime 注册副作用的 `@pluxel/runtime-dynamic/hmr/diagnose`
- `pluxel build`
  组装 `@pluxel/rolldown` + 相关 build helper
- `pluxel distribution`
  组装 `@pluxel/rolldown/distribution` 的 deterministic finalizer、离线验证和 marker helper
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
