---
title: CLI 与工具链
description: 了解脚手架、插件构建、应用执行、HMR、源码联调和发行检查分别由谁负责。
---

本页维护 CLI 加载、构建转换与 HMR 契约。生成项目已固定 `@pluxel/cli`，通过 package scripts 或 `vp exec pluxel` 调用。

按需读[安装与加载](#安装分层)、[构建边界](#source-build-boundary)或 [HMR](#hmr-失败与自动恢复)；源码接入与 catalog 见[源码工作区](./source-workspaces.md)。

源码定位使用 [inspect TypeScript API](./inspection.md)，没有 `pluxel inspect` 子命令。首次创建应用见[快速开始](../getting-started/index.md)；工作区任务、服务与日志入口见[工作区工具链](./workspace-toolchain.md)。

## 当前 CLI 命令地图

- 生成固定 example workspace：`vp create @pluxel [directory]`。
- 读取当前来源文档：`pluxel docs [path]`。
- 在 workspace 生成 Plugin package：`pluxel new`。
- 构建当前 Plugin package：`pluxel build`。
- 生成/检查/rebase database migration（`migrations` 策略）：`pluxel database generate/check/rebase`。
- 创建/检查/验证应用发行物：`pluxel distribution create/inspect/verify`。
- 写入/关联 delivery marker：`pluxel distribution mark/correlate`。
- 发布 npm package 并通知 market：`pluxel publish`。
- 控制当前 Vite 的 HMR 批次，操作插件、配置、Workbench 和日志：`pluxel dev status/hmr/run/result/cancel`，见[开发控制台](./dev-console.md)。
- 跨仓库 source checkout：`pluxel source register/list/unregister/doctor/build/install`。
- 管理与接入 workspace：`pluxel workspace setup/doctor/sync`。
- 维护依赖声明与 catalog：`pluxel pncat add/remove/migrate/clean`。

确切参数通过 `pluxel <command> --help` 查看。工作区候选缓存默认位于项目 `.pluxel`；`PLUXEL_STATE_DIR` 可改其位置，显式空值或空白会报错。该变量不迁移源码接入状态或开发控制台目录。

工作区接入、doctor 的检查范围见[开发资源与接入状态](./source-workspaces.md#文档skill-与接入状态)，依赖政策检查见[catalog](./source-workspaces.md#统一外部依赖)。产品依赖方向和目录规则由项目自己的 `governance:check` 负责。

## 安装分层

```sh
# 创建完整 example workspace
vp create @pluxel my-workspace

# 在已有 workspace 创建可发布 Plugin package
vp exec pluxel new --name @acme/orders plugins
```

项目内固定 CLI 版本：

```sh package-install
npx nypm add -D @pluxel/cli
```

个人机器上的随处可用入口；进入已固定 CLI 的项目后会委托本地版本：

```sh package-install
npx nypm add -g @pluxel/cli
```

CLI 来源选择：

- 发行版入口优先委托项目 `package.json` 直接声明的本地 `@pluxel/cli`；声明后未安装则失败，不回退全局版本。仅在最近的 Git/workspace/lockfile 边界内寻找安装，不借用独立父项目的 CLI。
- Git checkout 的 CLI 保持自身来源，不委托另一份项目 CLI。
- `source` 命令族使用实际调用入口；`list/register/unregister` 可用发行版 CLI，`install/build/doctor` 必须使用 Git CLI。接入步骤见[源码工作区](./source-workspaces.md#准备-checkout-和-cli)。
- CI 和 package scripts 使用本地 `pluxel` 或 `vp exec pluxel`。

CLI 是统一 executable，各能力按命令从当前项目加载：

Plugin/应用构建与源码转换：

```sh package-install
npx nypm add -D @pluxel/rolldown vite-plus
```

Native 应用执行：

```sh package-install
npx nypm add @pluxel/host
```

Vite 应用执行（开发或生产）：

```sh package-install
npx nypm add @pluxel/host-vite vite
```

具体装配见 [Host 配置](../host/configuration.md)。

`publish --webhook`：

```sh package-install
npx nypm add -D @pluxel/market
```

有 Workbench browser entry 的 host 还需要 Vite/React 等自己的 web toolchain。插件 package 的 canonical scripts 见 [开发和发布插件包](./plugin-package.md)。

`pluxel --help`、`pluxel --version` 和 `pluxel new` 不加载 Rolldown 或 market。缺少可选包只影响对应命令，并给出安装提示。

## 自定义本地 Plugin 模板

标准 Plugin package 使用内置 `plugin` 模板；团队目录、文档或工具配置可从显式本地路径生成：

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

首次写入前检查 manifest、UTF-8 token、路径包含关系、跨平台路径冲突和已有目标。本地模板默认不运行 package manager；审查内容后显式 `--install` 才会安装并执行 lifecycle scripts。

## 构建入口

Plugin package 使用 `pluxel build`，配普通 tsdown config；`--watch` 与 `--debug` 可用于持续构建和诊断。
CLI 安装标准 semantic pipeline，成功后同步 metadata；作者不重复安装转换插件。
完整 package 配置、Part 依赖聚合与 pack 验证见[插件包](./plugin-package.md)。自定义构建工具才使用 `@pluxel/rolldown/build` 的 `pluginPackage()`。

应用构建统一使用 `@pluxel/rolldown` 的 `pluxel()`，按[宿主构建配置](../host/configuration.md#生产构建)选择交付边界与资源 variant。

测试中实际构建 Workbench federation 产物时，在测试配置显式设置上游 `MFE_VITE_NO_TEST_ENV_CHECK=true`；MF 默认跳过测试环境中的 Vite 插件。构建器沿用调用方环境，不自动开启或覆盖此设置。
Plugin build 保留 provider peer 边界供多宿主使用；应用 build 按 `delivery` 选择部署闭包。

## Source build boundary

Host 的 Vite 接入执行 Plugin semantic lowering、config extraction、artifact discovery 和 HMR wiring。
Plugin source entry 必须通过这些 adapters 加载；Node 原生 type stripping 不生成 Pluxel metadata。Workbench browser
graph 与 server Plugin implementation 保持分离。

`host()`（以及组合它的官方 `vitePreset()`）拥有专用 `pluxel` Vite environment；应用、动态插件和控制台共享
其中的执行空间。默认 SSR 与第三方插件的 `ssrLoadModule` 保持独立，也可以配置自己的 SSR environment factory。
`hostSingletons({ packages })` 在 Host environment 内指定与 Node 宿主共享身份的包，需与 `host()` 一起使用。
第三方 SSR 加载出来的 Plugin constructor 不属于 Host；操作运行中的插件请使用控制台或 Host 的服务 API。

Host environment 默认使用 Vite 的 `resolve.tsconfigPaths` 解析项目 TypeScript 路径别名；若不需要，在 Vite config 显式设为 `false`。
源码中的 `// #if VITE_FEATURE` 条件编译读取当前 Vite mode 对应的环境变量；例如 `--mode staging` 使用 `.env.staging` 中的 `VITE_FEATURE`。条件编译在源码转换时完成，不读取请求期环境变量。
包导出条件沿用 Vite 的浏览器/服务端及开发/生产区分；Host 源码环境仅额外启用 Pluxel 的源码条件，不会让浏览器选择 Node 入口或让生产构建选择开发入口。
包导出与别名均先按当前 Vite 环境解析；Host environment 选中的 CommonJS 文件由 Node 加载，避免 `require is not defined`。浏览器代码误引 `node:fs`、`fs/promises` 等
Node 内置模块时，开发构建立刻报告模块名和导入者；把调用移到服务端，或通过 Vite alias 提供真正的浏览器实现。

Workbench Content 和 renderer 的候选更新、构建中/失败状态见[工作台故障](../workbench/operations.md#生命周期和故障)。

当前生成产物使用 Plugin lowering ABI v2，其中 root constructor arguments、Part constructor arguments 与 owner aggregate graph facts
是分离字段。旧 ABI artifact 不会被当成“没有 Part dependency”继续加载；看到 `plugin_lowering_abi_unsupported` 时，应配套升级
Core/Host/Rolldown 并重建 Plugin，而不是手写 `@pluxel/core/toolchain` helper。

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
稳定的可发布 Plugin 应使用 公开 package entry named export。

## HMR 失败与自动恢复

默认自动模式合并积压的源码事件；跨文件或连续修改时，coding agent 通过 [dev console 批次控制](./dev-console.md#hmr-批次控制)先暂停，检查后显式应用，验证成功后按原模式恢复。暂停只控制 Pluxel 的应用更新，不关闭普通浏览器 HMR。下述恢复发生在实际应用更新时；暂停期间继续记录变化，不逐次求值中间状态。

分别读取运行意图、当前状态和更新历史：批次已提交不等于全部插件已启动，单个插件失败也不等于整批失败。

显式 catalog 与动态来源的插件 HMR 都保留运行意图：启动失败的插件及被其 required dependency 阻塞的 consumer，在下一次有效源码更新后自动恢复；用户主动停止的插件保持停止。

“保留上一版”取决于失败发生在哪个阶段：

- 编译、模块求值、提交前依赖图校验：旧版本及其已建立的连接继续工作；连续失败也不会替换它；自动替换为新版本。
- 提交后的配置校验或 `init()`：旧 generation 已停止；失败节点及其 required consumer 暂不可用，其他节点可继续运行；按保留的运行意图自动恢复。
- 旧 generation 的资源清理：记录清理异常；新实例是否运行以当前状态为准；不根据历史清理异常推断启动失败。

插件 HMR 不保证 `init()` 失败时无中断保留旧实例：新旧版本可能争用独占资源，旧实例清理后不能安全原地复活。失败 generation 不发布部分 HTTP/WebSocket routes。

恢复由下一次有效更新触发，不做后台无限重试；没有新定义的重复通知也不触发启动。连续保存按提交队列顺序执行，前一次拒绝不阻塞排队的修复。是否恢复看当前状态；未恢复时检查配置、启动错误和 required dependency，不仅凭历史错误再次启动。
修改 application entry 或 host 配置会重建宿主，使用新的启动策略；这与同一宿主内保留运行意图的插件 HMR 不同，
详见 [宿主设置](../host/configuration.md)。

Vite 会保留失败候选的新依赖：新增 import 导致更新失败后，只修正新文件、创建缺失模块或完成依赖安装，也会自动重新求值。
成功接纳后释放这批恢复依赖。更新被拒绝时，旧后端继续使用旧 Workbench Content 与界面产物；候选产物在目录接受时才生效。

已知边界：Vite 8 的原生解析器可能缓存目录包指向不存在入口的成功解析；此时只改该目录包的 `exports`，仍可能返回旧入口。
如果诊断持续指向旧入口，可手动重启 dev 清除上游解析缓存。Pluxel 不通过私有缓存操作或自动重启绕过这个限制。

顶部更新状态展示最近一个批次，点击可查看失败阶段、触发文件、原因和可用的导入链。新增插件尚未进入目录也能显示批次错误。
“保留上一版”说明本次候选未被接纳，并不代表正在运行的旧插件失败。各插件自己的历史批次与生命周期问题仍在详情中保留。

Workbench 收到 publication、运行 generation 或产物变化造成的会话撤销时，会先释放旧页面资源，再自动整页刷新。
连续更新采用递增等待；10 秒内已自动刷新 3 次时暂停，显示手动刷新入口，避免错误导致页面反复跳转。认证失效和连接损坏不会自动重试。
刷新保留当前地址及已保存的工作区布局，不保存尚未提交的表单草稿。

## 验证

运行受影响 package 的实际 scripts；源码声明位置与脚本可用 [inspect](./inspection.md) 查询。
构建失败先看报错对应的 root export、constructor、`configs.use()`、`parts.use()` 或 literal declaration，不通过关闭 lowering 绕过错误。
当前应用的状态、最近更新和日志使用[开发控制台](./dev-console.md)读取。
跨 checkout 联调见[源码开发](./source-workspaces.md)，发行检查见[发行物](./distribution.md)。
