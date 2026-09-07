---
title: CLI 与工具链
description: 了解脚手架、插件构建、静态应用、HMR、源码联调和发行检查分别由谁负责。
---

`@pluxel/cli` 把脚手架、构建和诊断命令组织在一起；具体的 Vite、构建和运行时 API 仍由对应的包提供。CLI 是开发工具，不是应用运行时，因此业务代码不应从中导入运行时或构建辅助函数。

Coding agent 在线检查或操作已经运行的 Vite 宿主时，必须使用 [开发控制台](./dev-console.md) 的 `pluxel dev` 命令；先发现并固定项目和实例，再执行 TypeScript 操作。

## 安装分层

```sh
# 创建完整 example workspace
pnpm create @pluxel my-workspace

# 在已有 workspace 创建可发布 Plugin package
pnpm exec pluxel new --name @acme/orders plugins
```

项目内固定 CLI 版本：

```sh package-install
npx nypm add -D @pluxel/cli
```

个人机器上的随处可用入口；进入已固定 CLI 的项目后会委托本地版本：

```sh package-install
npx nypm add -g @pluxel/cli
```

`@pluxel/cli` 是统一 executable，但不是所有能力的安装闭包。项目 `package.json` 直接声明
`@pluxel/cli` 时，全局 `pluxel` 会优先使用这个项目本地版本；声明了但尚未安装时会失败并提示先安装，
不会悄悄回退到全局版本。唯一例外是 `pluxel source` 命令族：它始终使用实际调用的 CLI，以建立 source overlay 并安装项目固定版本；从源码 checkout 运行时还会自动识别 Pluxel 源码位置。CI 和 package scripts 应继续使用本地
`pluxel` 或 `pnpm exec pluxel`。CLI 只在最近的 Git/workspace/lockfile 项目边界内寻找本地安装；嵌套在
另一个 checkout 里的独立项目不会借用父项目的 CLI。

按命令安装可选能力：

Plugin/static build 与 Vite adapter：

```sh package-install
npx nypm add -D @pluxel/rolldown tsdown oxlint
```

Dynamic host：

```sh package-install
npx nypm add -D @pluxel/runtime-dynamic
```

`publish --webhook`：

```sh package-install
npx nypm add -D @pluxel/market
```

有 Workbench browser entry 的 host 还需要 Vite/React 等自己的 web toolchain。插件 package 的 canonical scripts 见 [开发和发布插件包](./plugin-package.md)。

这些 owner 只在执行对应命令时从当前项目解析和加载。`pluxel --help`、`pluxel --version` 和
`pluxel new` 不会加载 Rolldown、runtime-dynamic 或 market；缺少 owner 时只影响被调用的命令，并给出
安装提示。

## 当前 CLI 命令地图

| 目标                                                     | 命令                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------- |
| 生成固定 example workspace                               | `pnpm create @pluxel [directory]`                             |
| 定位上游当前文档                                         | `pluxel docs [path]`                                          |
| 在 workspace 生成 Plugin package                         | `pluxel new`                                                  |
| 构建当前 Plugin package                                  | `pluxel build`                                                |
| 生成/检查/rebase database migration（`migrations` 策略） | `pluxel database generate/check/rebase`                       |
| 创建/检查/验证 static distribution                       | `pluxel distribution create/inspect/verify`                   |
| 写入/关联 delivery marker                                | `pluxel distribution mark/correlate`                          |
| 发布 npm package 并通知 market                           | `pluxel publish`                                              |
| 操作当前 Vite 实例的插件、配置、Workbench 和日志         | `pluxel dev instances/run/result/cancel`                      |
| Dynamic loader 诊断                                      | `pluxel hmr prompt/doctor/enabled`                            |
| 跨仓库 source checkout                                   | `pluxel source register/list/unregister/doctor/build/install` |
| 管理 source workspace                                    | `pluxel workspace`                                            |

确切参数通过 `pluxel <command> --help` 查看。

`pluxel workspace doctor` 校验框架共同拥有的 workspace 契约：pnpm 主版本、workspace 文件，以及已激活时由 CLI
管理的 machine-local source `.pnpmfile.cjs`。产品自己的依赖方向和目录规则仍由项目 `governance:check` 负责。

## 自定义本地 Plugin 模板

只是创建标准 Plugin package 时使用 CLI 内置的 `plugin` 模板。团队需要固定自己的目录、文档或工具配置时，
可以从明确的本地路径生成：

```sh
pluxel new --template ./templates/company-plugin --name @acme/orders --no-install
```

`./`、`../`、absolute path 和 `file:` URL 才会选择本地模板；bare name 始终只解析 CLI 内置模板。
当前不支持 remote Git source 或 registry fallback，因此同名的本地目录、repository 或 package 不会改变 source kind。

每个 template root 包含一个严格的 `pluxel-template.jsonc`：

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

普通文件按字节复制。只有 `.tpl` 文件会在输出时去掉扩展名，并解析 `{{ key }}` 与
`{{ json key }}`；文件名也可以使用同样的 token。模板不支持 condition、loop、partial、dynamic helper、
JavaScript hook 或 post-create command，也不接受 symlink。

CLI 在首次写入前完成 manifest、UTF-8 token、path containment、portable collision 和已有目标检查。
local template 默认不运行 package manager；审查模板内容后显式传入 `--install` 才会执行安装及 lifecycle scripts。

## `pluxel build`

命令以当前 package root 为边界：

1. 读取 `package.json` 与 tsdown config；
2. 合并标准 Plugin build pipeline；
3. 运行 preprocessor、decorator/config semantic extraction，并聚合 PluginPart dependency facts；
4. 生成 server ESM 与 declarations；
5. 按 declaration 生成 Workbench Content/MF producer、Node module、worker、database artifact；
6. 成功后事务性同步 generated package metadata。

用户 `tsdown.config.ts` 只描述 entry/output/minify/sourcemap 等普通 bundler 配置。不要再次安装第二套 semantic plugin。

```sh
pluxel build
pluxel build --watch
pluxel build --debug
```

package script 传参时：

```sh
pnpm build -- --watch
```

Plugin 与 concrete direct `PluginPart` subclass 都可以在 constructor 声明 required dependency。工具链保留每个 constructor 的参数
顺序，再把 reachable Part requirements 提升、去重到 owning Plugin graph。生成 package metadata 时，同一 provider package 只出现
一次，任一 constructor 来源为 required 都会覆盖 optional classification；作者不要在 owner constructor 或 `package.json` 复制一份
Part dependency allowlist。metadata collector 从 package 的 concrete Plugin roots 遍历本地 Part containment；仅被 transform、但没有被
任何 owner 使用的 Part 不进入清单。外部 package 提供的预构建 Part 由其所属 package 声明自己的 provider peers，consumer package
不会反查或复制它的传递 inventory。

## `pluginPackage()` 与 CLI build

`pluginPackage()` 是 `@pluxel/rolldown/build` 的底层 library integration。CLI template 的 canonical 入口是 `pluxel build` + 普通 tsdown config；不要同时把两种模式叠加。

直接构建自定义工具时才调用 library API：

```ts twoslash
import { pluginPackage } from '@pluxel/rolldown/build'
```

普通 Plugin 作者不需要直接使用它。

## Static application build

Static application 使用不同输出拓扑：

```ts twoslash
import { staticApplication } from '@pluxel/rolldown/build'

export default staticApplication({
	entry: './src/pluxel.static.ts',
	variant: 'workbench',
	target: 'node',
})
```

| Build              | 依赖策略                              | 输出目的             |
| ------------------ | ------------------------------------- | -------------------- |
| Plugin package     | 保留 runtime/provider peer boundary   | npm 发布与多宿主复用 |
| Static application | 冻结 fixed closure 与 Node deployment | 可部署完整目录       |

不要把 static application preset 用于独立 Plugin package，也不要把 target 机安装 package 当作 static closure 的一部分。

## Source build boundary

Static/dynamic Vite adapters 执行 Plugin semantic lowering、config extraction、artifact discovery 和 HMR wiring。
Plugin source entry 必须通过这些 adapters 加载；Node 原生 type stripping 不生成 Pluxel metadata。Workbench browser
graph 与 server Plugin implementation 保持分离。

`workbench.markdown(import.meta.url, './guide.md')` 的 source 会进入 adapter watch graph，并在 server transform 阶段编译；
Content-only definition 不创建 browser module graph，即使 Content 包含 data/action slot。Definition 同时含 Content 与 View
renderer 时，dev compiler 会先提交 definition topology 与 Content plan；已有 producer artifact 快速复用，缺失或过期的
producer 在后台构建，完成后再提交完整 tuple 并触发 Workbench session reload。后台 producer 失败不会阻塞 Runtime
启动，对应 View/Attachment placement 会保留在 layout 中，未就绪时显示构建中，失败后显示错误状态。Content schema 与
handler 只留在 server binding，不进入 browser projection；production/static build 仍要求 Content 与 MF producer 全部严格通过后才发布 artifact。

当前生成产物使用 Plugin lowering ABI v2，其中 root constructor arguments、Part constructor arguments 与 owner aggregate graph facts
是分离字段。旧 ABI artifact 不会被当成“没有 Part dependency”继续加载；看到 `plugin_lowering_abi_unsupported` 时，应配套升级
Core/Runtime/Rolldown 并重建 Plugin，而不是手写 `@pluxel/core/toolchain` helper。

低层 source adapter 默认把 `root` 映射为逻辑 source space `app`。需要承载不属于 package root 的额外源码树时，显式声明
稳定的逻辑名称：

```ts no-twoslash
import { pluginSourceVitePlugins } from '@pluxel/rolldown/vite'

const plugins = pluginSourceVitePlugins({
	root: '/srv/orders-host',
	sourceSpaces: [{ name: 'managed', root: 'plugins/managed' }],
})
```

相对 `root` 解析物理目录；嵌套映射选择最具体的 source space。工具链对 root 和 entry 使用 native `realpath`，因此可以使用
symlinked root，但会拒绝通过文件 symlink 逃出 root。修改 `name`、root 映射或嵌套关系会改变 Plugin address；需要跨宿主布局
稳定的可发布 Plugin 应使用 package root named export。

## Node/worker artifact

`defineNodeModule()` 和 `defineWorkerTask()` 的 literal declaration 会生成 `dist/artifacts/node/` 下的独立 ESM。artifact 使用独立 graph validator，不能 value-import Plugin runtime/Context。

详细 clone/native/lifecycle 约束见 [Node module 与 worker task](../runtime/node-artifacts.md)。

## HMR 失败与自动恢复

排查更新时分别看三个事实：运行意图决定插件是否应该运行，当前状态说明它是否已经运行，更新历史说明上次更新发生了什么。
一次更新已提交，不代表每个插件都已启动；某个插件启动失败，也不代表同一批次里的其他插件失败。

Static 与 dynamic host 的插件源码 HMR 都保留运行意图。原来要求运行的插件即使启动失败，也不会被改成手动停止；
下一次有效源码更新会自动启动修复后的版本，连同被 required dependency 阻塞的 consumer 一起恢复，不需要去工作台点击“启动”。
用户主动停止的插件则继续停止，源码更新不会覆盖这个选择。

“保留上一版”取决于失败发生在哪个阶段：

| 失败阶段                         | 期间的服务状态                                                                    | 修复源码后的行为               |
| -------------------------------- | --------------------------------------------------------------------------------- | ------------------------------ |
| 编译、模块求值、提交前依赖图校验 | 旧版本及其已建立的连接继续工作；连续失败也不会替换它                              | 自动替换为新版本               |
| 提交后的配置校验或 `init()`      | 旧 generation 已停止；失败节点及其 required consumer 暂不可用，其他节点可继续运行 | 按保留的运行意图自动恢复       |
| 旧 generation 的资源清理         | 记录清理异常；新实例是否运行以当前状态为准                                        | 不根据历史清理异常推断启动失败 |

因此，普通插件 HMR 不保证任意 `init()` 失败都能无中断保留旧实例。新旧版本可能争用同一端口、连接或其他独占资源，
旧实例清理后也不能安全地原地复活。失败 generation 不会发布部分 HTTP/WebSocket routes。

这里的自动恢复由下一次有效更新触发，不是后台无限重试。没有新定义的重复通知也不是“启动”命令。
连续保存时，进入提交队列的更新按顺序执行；前一次被拒绝不会堵住已经排队的修复更新。修复后的状态以当前运行状态为准，
不要仅凭历史错误再次点击“启动”；仍未恢复时，先检查本节点的配置、启动错误和阻塞它的 required dependency。
修改 application entry 或 host 配置会重建宿主，使用新的启动策略；这与同一宿主内保留运行意图的插件 HMR 不同，
详见 [宿主设置](../getting-started/host-setup.md)。

## HMR diagnostics

Dynamic host 用户通过：

```sh
pluxel hmr doctor
pluxel hmr prompt
pluxel hmr enabled
```

workspace diagnostics 的 library subpath 是 `@pluxel/runtime-dynamic/hmr/diagnose`。它诊断 profile、source discovery 和 snapshot，不注册 dynamic runtime services。

## 验证顺序

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

遇到 build-time error 时先按作者边界判断：

- root export 是否唯一可追溯；
- Plugin/PluginPart constructor dependency 是否从 provider root value-import，同一 constructor 是否重复 definition；
- Plugin/PluginPart 的 `configs.use()` 是否各自是唯一的 object schema class field；
- `parts.use()` 是否完整占据普通 class field，并引用 direct `PluginPart` subclass；
- optional ref/use 是否符合 direct-call shape；
- Workbench/worker/database declaration 是否使用 literal entry。

跨 checkout 联调见 [跨仓库源码开发](./source-workspaces.md)，发行物命令见 [Static 发行物](./distribution.md)。
