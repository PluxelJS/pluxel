# @pluxel/cli

Pluxel CLI（对外发布包之一）。

它是用户侧的命令入口，自身不定义 runtime、HMR 或构建协议。命令实现按需加载，未使用的能力不要求安装，也不会在 `pluxel --help` 或 `pluxel new` 时初始化。

如果你在追：

- runtime / loader HMR / build 的总边界：看 `engineering/RUNTIME.md`、`engineering/HMR.md`、`engineering/TOOLCHAIN.md`
- 插件前端链路：看 `engineering/FRONTEND.md`
- 发布与内联约束：看 `engineering/GOVERNANCE.md`

常用：

```sh
pluxel build
pluxel hmr
pluxel new
pluxel source doctor
pluxel distribution inspect ./dist
```

`pluxel new` 只在已有 workspace 或指定 destination 中创建可发布 Plugin package。官方 `plugin` 模板固定 pnpm 11，
默认安装依赖；传入 `--no-install` 可以只生成文件。local template 默认不执行安装，只有显式 `--install` 才会运行其
package manager lifecycle scripts。非交互调用使用 manifest 显式声明的 prompt default，缺少 default 时直接失败。

从零开始的完整 example monorepo 由独立的 `@pluxel/create` 提供：

```sh
pnpm create @pluxel my-workspace
```

create 发布并复制固定 starter 与 `docs/pluxel/` 文档快照，不加载 CLI，也不共享 Plugin template。生成的 starter
把 `@pluxel/cli` 作为项目开发工具安装，后续可在其中运行 `pluxel new`。两个入口的输出有意不同，不存在 parity
contract。

`@pluxel/cli` 可以全局安装；如果当前目录向上最近的 `package.json` 直接声明了本地 `@pluxel/cli`，全局 launcher
会在加载 CLI main 前委托该项目版本。声明了但没安装时会报错，不回退到全局版本。

### Local template contract

local template 必须用 `./path`、`../path`（Windows 也接受 `.\\path`、`..\\path`）、absolute path 或 `file:` URL 显式选择；bare name 始终只查找当前 CLI
携带的官方模板。当前不支持 remote Git source 或 registry fallback。

每个 template root 必须包含一个 `pluxel-template.jsonc`：

```jsonc
{
	"schemaVersion": 1,
	"id": "company-plugin",
	"packageManager": { "name": "pnpm" },
	"prompts": [
		{
			"name": "description",
			"type": "text",
			"message": "Package description",
			"default": "Pluxel plugin: {{ className }}Plugin",
		},
	],
}
```

manifest 会拒绝 unknown field、重复 prompt、不匹配的 default 和不支持的 schema version。prompt `name` 必须匹配
`[A-Za-z][A-Za-z0-9_]*`，并且不能占用 `pluginName`、`packageName` 或 `className`。所有 CLI template 都使用 Plugin
package 命名规则；application workspace 不属于这个 contract。

普通文件逐字节复制。只有以 `.tpl` 结尾的 UTF-8 文件会执行插值并在输出时去掉该扩展名；文件名也可以使用同一
语法：

```text
{{ packageName }}
{{ json description }}
```

除此之外不支持 helper、block、condition、loop、partial 或 JavaScript hook。symlink、输出路径逃逸、portable path
collision 和旧 `.hbs`/control file 都会在写入目标前失败。自定义模板示例：

```sh
pluxel new --template ./templates/company-plugin --name @acme/orders --no-install
```

维护者可运行 `pnpm --filter @pluxel/cli test:templates`。该检查会计算并打包当前 workspace 的本地
发布依赖闭包，安装真实 CLI tarball，在仓库外生成 standalone plugin，并完成独立安装、lint、typecheck、test、
build 和 package smoke。create starter 的独立发布 smoke 位于 `@pluxel/create`。

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
这些 owner 都从调用项目解析，只在执行对应命令时加载。`pluxel --help`、`pluxel --version` 和
`pluxel new` 不会初始化它们。

多个独立 pnpm 仓库共同修改未发布源码时使用 `pluxel source register/doctor/install/build`。项目提交
`pluxel.sources.jsonc` 中的仓库身份，机器路径只进入用户 checkout registry；CLI 从真实 package 依赖
推导 override 和构建闭包，并让 lockfile 只记录 `.pluxel/sources/<repository-hash>/<package-slug>-<package-hash>`
package-level 稳定代理路径。完整
用法见打包的 `docs/development/source-workspaces.md`。

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
