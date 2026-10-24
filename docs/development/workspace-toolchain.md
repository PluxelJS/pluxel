---
title: 工作区工具链
description: 用 mise 固定工具、hk 执行提交检查、Pitchfork 管理开发服务，保持应用操作与进程管理边界清晰。
---

官方 monorepo 和 `@pluxel/create` 项目以 mise、Vite+、hk、Pitchfork 作为默认开发工作区。先按[快速开始](../getting-started/index.md)创建应用；本页用于准备 checkout、管理服务、调整检查，以及指导 coding agent 修改工具配置。生产交付见[应用交付](./distribution.md)。

按任务读取，不必通读：

| 当前任务                        | 入口                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| 准备 checkout、安装工具或 hooks | [准备 checkout](#准备-checkout)                                                             |
| 调整构建、检查或缓存            | [构建与检查](#构建检查与任务图)、[Vite Task](#下游迁移到-vite-task)                         |
| 启动服务、查日志或调整反代      | [管理服务](#管理开发服务)、[排障入口](#agent-的日志与排障顺序)、[公开地址](#端口与公开地址) |
| 修改 hk / Pkl 或 CI             | [hk 配置](#修改-hk-与-pkl-配置)、[GitHub Actions](#github-actions)                          |
| 在线读取或修改应用              | [开发控制台](./dev-console.md)                                                              |

## 每个工具维护什么

| 文件或工具                 | 职责                                                                            |
| -------------------------- | ------------------------------------------------------------------------------- |
| `mise.toml`                | 固定 Node、pnpm、Vite+、hk、Pitchfork 版本，配置环境变量和 PATH，不定义项目任务 |
| `vite.config.ts`           | Vite+ 的任务、pack、lint 与 fmt 入口；每份规则只有一个来源                      |
| `pitchfork.toml`           | 用 **TOML** 声明长期服务、启动命令、分配端口与就绪条件                          |
| `hk.pkl`                   | 用 **Pkl** 声明提交检查、文件选择和检查/修复命令                                |
| `package.json` / Vite Task | package 声明依赖；Vite Task 声明命令、依赖图和缓存                              |
| Pluxel dev console         | 控制现有 Vite 的 HMR 批次，读取或操作 Plugin、配置、报告和应用日志              |

mise 管理工具的安装和执行环境；package scripts 提供统一操作入口；Pitchfork 管理进程；hk 调用项目检查。不要在三份配置中分别实现同一个检查，也不要用新的后台脚本重做 Pitchfork 的端口、重试或日志管理。

执行工具和规则文件分别决定。较大的 lint / fmt 策略可放在独立的 `oxlint.config.ts` / `oxfmt.config.ts` 模块，由根 `vite.config.ts` 显式导入到 `lint` / `fmt`；简短配置也可内联。`vp check` 以工作区根配置为入口，因此不要同时维护内容重复的 rc 文件；使用 `vp` 不要求把所有规则都写进 Vite 文件。相关行为见 [Lint](https://viteplus.dev/config/lint) 与 [Fmt](https://viteplus.dev/config/fmt)。

官方应用和 Plugin 模板分别通过 `oxlint.config.ts` 与 `oxfmt.config.ts` 维护规则，根 Vite 配置引用这些模块。

## 构建、检查与任务图

package scripts 是人和 IDE 的入口，Vite Task 拥有实际命令、依赖图与缓存。包内 `vite.config.ts` 使用原生 task 名并就地声明特殊依赖与缓存；`scripts/vite-tasks.ts` 只提供共用默认，不按包名分发隐藏规则。根任务从 `pnpm-workspace.yaml` 的实际成员聚合，不维护第二份目录清单。根 `build` / `test` / `verify` 委托 `workspace:*` 聚合任务；叶包的标准 `build` / `test` / `typecheck` 分别委托 `compile` / `check-tests` / `check-types`，保留 source 发现与外部调用入口。不要同时定义同名 script 和原生 task，也不要在 mise 重复定义任务。框架的具体实现与包依赖环处理见[工作区任务图](https://github.com/PluxelJS/pluxel/blob/main/engineering/CLI_WORKSPACES.md#工作区任务图)。

本仓库与模板使用 `run.cache.scripts: false, tasks: true`：入口每次执行，底层构建与测试按输入复用缓存，开发服务和验收入口不会被缓存跳过。IDE 的 `pnpm run build` 仍进入同一任务图。简单下游也可直接用 scripts 并启用其缓存；存在依赖顺序、产物或环境规则时再声明原生 task。参考 [run 配置](https://viteplus.dev/config/run)。

| 操作                    | 入口与边界                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 静态检查 / 修复         | `vp check` / `vp check --fix`；格式由根 `fmt` 配置拥有，类型由 `lint.options.typeAware` 与 `typeCheck` 启用，见 [Check](https://viteplus.dev/guide/check)    |
| 完整门禁                | `vp run verify` 通过 `dependsOn` 组合治理、检查、测试与构建；提交前增量检查不能替代它                                                                        |
| 源码打包 / 发布 tarball | `vp pack` / `vp pm pack`，两者不可互换；独立打包配置使用 `vite-plus/pack`，下游由 `vite.config.ts` 引用，Plugin 仍用 [`pluxel build`](./tooling.md#构建入口) |
| 普通依赖操作            | `vp install/add/remove/exec/run` 按 `packageManager` 使用固定 pnpm，见 [Vite+ 包管理](https://viteplus.dev/guide/package-management)                         |
| 官方 catalog 政策       | `vp exec pluxel pncat add/remove/migrate/clean` 修改声明；`pluxel workspace sync` 只对齐已有 catalog 版本，不改依赖声明，不另设重复脚本                      |

框架的独立 `check-types` 还覆盖明确的 tsconfig、编译期 API probes 与前端配置；例如 `*.typecheck.ts` 不进入源码语义 lint，不能因 `vp check` 已检查类型就删除它们。普通下游只有额外类型契约时才增加独立任务。源码、测试、benchmark 和构建配置默认由同一份包 `tsconfig.json` 检查；只有不同运行环境或声明构建输入确需隔离时才增加配置。共享检查选项由根 `tsconfig.json` 维护，不建立只做转发的继承层。

升级 Vite+ 时同步 mise 版本、`vite-plus` catalog、指向 Vite+ Core 的 `vite` npm alias，以及精确的 `peerDependencyRules.allowedVersions.vite`，再验证插件兼容性。Core 有独立版本号。vendor 中已接入工作区的包执行根任务图，未接入的第三方项目保留自己的配置。

## 下游迁移到 Vite Task

把真实命令、依赖顺序和缓存规则放进 `vite.config.ts` 的 `run.tasks`。例如一个应用可以这样组织交付；这里的 `scripts/deploy.mjs` 是项目自己的部署实现：

```ts
import { defineConfig } from 'vite-plus'

export default defineConfig({
	run: {
		tasks: {
			build: { command: 'vp build' },
			test: {
				command: 'vp test run',
				cache: { input: [{ auto: true }], output: [], env: ['CI', 'NODE_ENV'] },
			},
			deploy: {
				command: 'node scripts/deploy.mjs',
				dependsOn: ['build', 'test'],
				cache: false,
			},
		},
	},
})
```

运行 `vp run deploy` 会先完成构建与测试，共享依赖任务只执行一次，不要在每个命令中再跑整仓 build。测试消费构建产物时才声明 `dependsOn: ['build']`；直接测源码则无需依赖。新增 deploy 可直接定义为 task，标准 scripts 的保留规则见上节。

Monorepo 用 `dependsOn: [{ task: 'build', from: ['dependencies', 'devDependencies', 'peerDependencies'] }]` 表达依赖包构建，或用 `@example/domain#build` 指定任务。引用必须指向实际原生任务；官方模板使用 `compile` / `check-tests`，不再经过外层 scripts。包依赖有环时使用明确构建边，不能依赖递归 package 排序。语法见 [Vite Task](https://viteplus.dev/guide/run)。

标准 `vp build` 会自动报告输入、输出与相关环境变量，无需重复手写这些设置。组合 Pack、Pluxel 编译或自定义命令时，缓存需要覆盖真实契约：

- `input: [{ auto: true }]` 保留自动文件追踪；跨包共享配置可补充 `{ pattern: 'tsconfig.base.json', base: 'workspace' }`。不要排除构建实际读取的模板、声明、测试夹具或文档资源。
- 直接复制已安装包资源的构建任务显式包含这些资源。例如 standalone 构建复制 Workbench Shell 时，在保留 `{ auto: true }` 的输入中添加 `{ pattern: 'node_modules/@pluxel/workbench/dist/public/**', base: 'package' }`。将输入声明放在实际消费资源的任务中，并用资源内容变更验证缓存失效；source overlay 的目录符号链接也需要这项验证。
- `output` 声明可恢复的产物，例如 `dist/**`；测试通常使用 `[]`。每份产物只由实际生成它的任务归档，聚合任务不重复归档子任务的输出。多个构建阶段使用 `dependsOn` 排序并各自声明输出；不要用一个缓存任务串联多个会继承同一输出范围的命令，否则后续命令命中旧缓存时可能覆盖刚生成的文件。输出目录嵌套时，用 `!dist/resources/**` 这类排除项明确归属。
- `env` 声明影响结果的环境变量，例如 `CI`、`NODE_ENV` 和构建开关；密钥不能写进配置。自动环境追踪的适用范围见 [Automatic Data Tracking](https://viteplus.dev/guide/automatic-data-tracking)。
- 部署、发布、数据迁移、实时服务检查和外部集成测试使用 `cache: false`。URL 没变不能证明远端服务状态没变。官方模板的治理与完整验收入口每次执行，底层构建和单元测试仍复用缓存。

迁移后连续执行两次 `vp run verify`，检查第二次的 cache hit；再删除一个构建产物验证恢复，修改一个真实输入确认相应任务失效。CI 或需要指定并发与查看任务报告时，直接调用原生聚合任务，例如 `vp run --concurrency-limit=2 workspace:verify`，避免 package script 再启动内层 runner，让限制与报告覆盖实际任务图。`vp run --last-details` 显示上次执行细节；需要强制重跑使用 `--no-cache`。CI 持久化 `node_modules/.vite/task-cache`，避免每次 checkout 都失去缓存。完整配置参考 [Task Caching](https://viteplus.dev/guide/cache) 与 [run 配置](https://viteplus.dev/config/run)。

## 准备 checkout

先按 [mise 入门](https://mise.jdx.dev/getting-started.html)安装并激活 mise，检查 checkout 的 `mise.toml` 后在根目录运行：

```sh
mise trust
mise install
mise exec -- vp install --frozen-lockfile
vp run
```

- 源码 checkout 首次安装后执行 `vp run @pluxel/cli#compile` 准备 CLI，再运行 `vp run dev`。修改 CLI 后按启动器提示重建；日常复用服务不重建 CLI。
- 新生成项目尚无锁文件时用 `mise exec -- vp install`，安装后运行 `vp run setup` 接入开发资源；这一步不要求 Git。已有 Git 仓库运行 `vp run hooks:install`，新应用先显式 `git init` 再安装 hooks。
- 首次安装直接用 `vp install`，不经任务发现。`mise.toml` 的 `env._.path = ["node_modules/.bin"]` 让已安装项目优先用本地 Vite+；安装前才用 mise 提供的入口。未激活 shell 的 CI / agent 使用 `mise exec -- <command>`。版本以 checkout 为准，相对路径按 [mise 配置根目录](https://mise.jdx.dev/configuration.html#config-root)解析。

| 验证范围                      | 命令                                         |
| ----------------------------- | -------------------------------------------- |
| hk 配置有效                   | `hk validate`                                |
| 改动文件 / hk 全量文件        | `hk check` / `hk check --all`                |
| 全项目静态检查 / 完整交付门禁 | `vp run check` / `vp run verify`             |
| 显式修复后审阅 diff           | `hk fix`（改动文件）/ `vp run fix`（全项目） |

非交互环境可给上述命令加 `mise exec --`。`hk check --all` 的范围取决于 `hk.pkl`，不能替代完整交付门禁；文件选择参数见 [hk CLI](https://hk.jdx.dev/cli/)。

`hk validate` 只验证配置，不证明 Git hook 已安装。执行 `vp run hooks:install` 后核对实际 pre-commit 入口；Git 2.54+ 可用 `git hook list --show-scope pre-commit` 查看原生配置 hook，不应只凭 `.git/hooks/pre-commit` 是否存在判断。安装方式与旧版 Git 的脚本 hook 见 [hk install](https://hk.jdx.dev/cli/install.html)。

## 进入工作区时的可选诊断

mise 的 `hooks.enter` 是环境生命周期入口，不需要恢复 `[tasks]`。它在从项目外进入时执行，项目内切换目录不重复执行；`hooks.cd` 则每次切换都执行。信任或新建配置也可能触发 enter，见 [mise Hooks](https://mise.jdx.dev/hooks.html)。

安装 CLI 并完成 source 接入后，可在本机 `mise.local.toml` 启用：

```toml
[hooks]
enter = 'pluxel source doctor --root "{{config_root}}"'
```

npm 消费项目用 `pluxel workspace doctor --root "{{config_root}}"`。显式 root 避免从子目录进入时检查错对象；首次 clone 先安装工具、依赖并构建 CLI。共享配置默认不开启这个 hook。

只调用现有只读诊断：`source doctor` 检查声明、checkout 与 overlay，不证明产物最新。安装、构建、setup 与 sync 仍显式执行；不得借 enter 自动改文件或用 `|| true` 隐藏诊断。enter 依赖 shell activation，IDE、CI、agent 非交互命令与 `mise exec` 不保证触发；失败只产生警告，不是门禁，“进入目录无报错”也不是验证证据。

## GitHub Actions

本仓库通过 [mise-action](https://github.com/jdx/mise-action) 读取同一份 `mise.toml`，安装 Node、pnpm、Vite+、hk 和 Pitchfork。Action 使用上游持续维护的大版本标签，自动接收该大版本内的更新；`.github/dependabot.yml` 每周检查并分组提出跨大版本升级。Action 的版本与 `mise.toml` 中固定的工具版本是两层配置，更新 Action 不会自动升级项目工具。

[Vite+ 官方 setup-vp](https://github.com/voidzero-dev/setup-vp) 可负责 Vite+、Node、包管理器、依赖安装与依赖缓存，适合采用它统一初始化的 CI。本仓库已由 mise 管理这些工具，保留一个安装入口；Vite Task 结果缓存仍需单独持久化。若下游选择 setup-vp，按其官方要求使用精确发布版本并由 Dependabot 更新：它的 `@v1` 标签已冻结，不会跟随新版本。

[hk 官方 CI 指南](https://hk.jdx.dev/ci.html) 使用 mise 安装工具后直接运行 `hk validate` 和 `hk check --all`，无需安装 Git hooks。本仓库的完整门禁由 Vite Task 执行 `vp check`、类型检查、测试与构建，hk 复用相同检查器处理本地提交文件，避免 CI 重复执行全量检查。

## 管理开发服务

先读 `pitchfork.toml`，再用 `pitchfork list` 确认目录、namespace、完整服务 ID 和已有进程。模板默认服务是 `app`，框架仓库是 `plugin-host`，文档站是 `docs`。日常入口为 `vp run dev` / `vp run docs`；profile 的配置、默认选择、前台 `command` 模式和无控制台服务只在[项目入口与启动方式](./dev-console.md#项目入口与启动方式)维护。

```sh
pitchfork start app
pitchfork status app
pitchfork logs app
pitchfork restart app
pitchfork stop app
pitchfork wait app
```

`start` 等待配置的就绪条件，退出后服务由 supervisor 继续管理；`wait` 等待服务**停止**，不是等待就绪。跨目录将示例中的 `app` 换成发现的完整 ID。只操作本任务所属服务；参数以 `pitchfork <command> --help` 和 [CLI Reference](https://pitchfork.jdx.dev/cli/)为准。

启动链只有一条：package `dev` script → `pluxel dev` → Pitchfork → 应用包 `dev:server` script → Vite。Pitchfork 的 `mise = true` 加载工具版本、PATH 与项目环境变量，不经过 mise task，也不回调根 `dev`。源码仓库的 `dev` / `pluxel` scripts 直接调用 CLI，不在每次在线操作前恢复构建缓存，避免意外触发 HMR。停止、重启与进程日志继续用原生 Pitchfork。

`mise = true` 还要求 Pitchfork 能定位 mise。非标准安装位置（例如 Nix profile）需要在所属项目 Git 根目录的已忽略 `pitchfork.local.toml` 中设置实际可执行路径：

```toml
[settings.general]
mise_bin = "/absolute/path/to/mise"
```

用 `command -v mise` 查询路径；保留本机文件中已有的 namespace 等设置，不提交绝对路径。用 `pitchfork settings explain general.mise_bin` 确认来源是目标检出的 local 文件，再重启所属服务并确认实际环境已加载。Pitchfork 2.30.1 在 Unix 上的默认查找不包含 `PATH`，见[原生 mise 配置](https://github.com/jdx/pitchfork/blob/v2.30.1/src/settings.rs#L180-L201)；该版本在嵌套检出中运行 `settings set --local` 可能选到外层项目，因此直接维护目标 local 文件并核对来源。

`pluxel dev` 首次和重复启动均显示 Vite 当前地址。应用状态、在线操作与业务日志使用[开发控制台](./dev-console.md)；Pitchfork 只负责进程。模板的 `vp run dev:local` 提供前台 Vite 交互，后续控制台操作选择 `--profile local`；数据共用与并行隔离要求也见该指南。

### 按访问启动与服务复用

Pitchfork 服务、稳定 URL 与日志独立于终端或 agent 会话。复用现有服务；后台服务不承载 Vite 的 `h/o/r` 键盘交互，需要时使用模板的 `dev:local`。

代理启用、supervisor 已运行且项目已注册后，访问已停止服务的 URL 会启动它及其 `depends`。首次 checkout 先安装工具和依赖，再用 `vp run dev` 显式启动；仅切换目录不会注册项目。从 `pitchfork list --json`、`pitchfork status app --json` 或 `pitchfork proxy status` 取实际 URL，不拼域名。访问会执行启动命令，只访问本任务所属服务。

首次请求等待启动后转发，并发请求可能收到自动刷新的启动页；依赖失败返回错误。启动页或 HTTP 响应不证明应用 ready。代理默认等 30 秒，超时后后台启动继续；模板的 `ready_output.timeout` 为 5 分钟，但不改变代理预算。冷构建优先显式 `pitchfork start app`，或调整 `settings.proxy.auto_start_timeout`，不要因请求超时重复启动或自建轮询。

空闲停止默认关闭，可按需设置 `proxy.idle_timeout`；代理上的 HMR WebSocket 计入活动，显式 CLI 启动的服务不受空闲停止控制。依赖、并发与回收使用原生 [Auto-Start](https://pitchfork.jdx.dev/guides/port-management#auto-start) / [Idle Shutdown](https://pitchfork.jdx.dev/guides/port-management#idle-shutdown)。Redis 等 TCP 服务可随依赖启动，但客户端仍直连其端口，不经过 HTTP 反代。

### 端口与公开地址

官方工作区默认使用项目 `pitchfork.toml` 中的 HTTP 反代配置，对外统一端口 `8088`。新机器安装工具和依赖后，直接运行 `vp run dev`；Pitchfork 自动启动 supervisor 和代理，不要求创建 `~/.config/pitchfork/config.toml`，不需要证书、sudo、系统 DNS 或 hosts 修改。

多个应用共用同一个代理端口，按域名路由，例如 `http://app.project-a.localhost:8088` 与 `http://app.project-b.localhost:8088`。框架仓库使用 `plugin-host`、`docs` 两个服务名。应用内部仍各有 listener，`port` 与 `bump` 由 Pitchfork 分配，通过 `PORT` 交给 Vite；浏览器和书签只使用公开 URL，不保存内部端口。

项目默认配置如下；`auto_trust`、`dns`、`sync_hosts` 显式关闭，保持纯本地 HTTP：

```toml
[settings.proxy]
enable = true
https = false
host = "127.0.0.1"
tld = "localhost"
lan = false
port = 8088
auto_trust = false
dns = false
sync_hosts = false
```

浏览器需要支持 `*.localhost` 的本地解析。命令行客户端的系统解析行为可能不同；本配置不安装系统解析规则。无需运行 `pitchfork proxy setup`。HTTPS、自定义 TLD 或 LAN 访问是额外部署选择，按[官方反代指南](https://pitchfork.jdx.dev/guides/port-management)配置。

**已有 supervisor 的配置迁移：** 设置只在共享 supervisor 启动时读取，进入另一项目不会重配。先用 `pitchfork list` 检查已有服务；确需采用本项目设置时，在项目根显式运行 `pitchfork supervisor start --force` 并重启所需服务，日常 `dev` 不强制执行。用 `pitchfork proxy status` 核对地址；`8088` 被占用时先解决冲突。相同配置共享代理，不为每个应用另开代理。见[设置加载规则](https://pitchfork.jdx.dev/reference/settings.html#when-changes-take-effect)。

Pitchfork 2.30.1 的路由表有约两秒缓存；第二个项目刚注册后立即请求可能短暂返回 `Unknown project`，稍后刷新即可。服务 ready 与代理路由缓存更新是不同的完成条件。

Pluxel 的开发地址契约与代理供应商分开：

| 输入                                    | 用途及优先级                                     |
| --------------------------------------- | ------------------------------------------------ |
| `PLUXEL_PUBLIC_ORIGIN`                  | 显式 HTTP(S) 公开 origin，优先于自动集成输入     |
| `PITCHFORK_URL`                         | Pitchfork 提供的公开 URL；没有显式 origin 时采用 |
| `PLUXEL_HOST_BIND` / `PLUXEL_HOST_PORT` | 显式监听地址和端口，分别优先于 `HOST` / `PORT`   |
| `HOST` / `PORT`                         | 通用进程监听输入，未启用代理也可使用             |

公开 origin 用于终端 `Application` / `Workbench` 地址与管理会话同源校验；实际 listener 地址保持物理地址。没有公开 origin 时显示 Vite 本地地址。Pluxel 不通过任意请求的转发头猜测可信 origin。切换其他反代时设置 `PLUXEL_PUBLIC_ORIGIN`，并让反代转发 HTTP 与 Vite WebSocket；这个变量本身不会建立代理路由或配置证书。需要前台调试时使用[command profile](./dev-console.md#项目入口与启动方式)，不要用托管服务的 profile 连接手动进程。

### 就绪、健康与应用操作

就绪检查应验证实际入口；TCP 监听只证明端口可连接。多个 `ready_*` 条件是“任一成功”，必须全部满足时合并为一个 `ready_cmd`。就绪用于启动依赖，持续健康检查另行按需配置，见[就绪检查](https://pitchfork.jdx.dev/guides/ready-checks.html)和[健康检查](https://pitchfork.jdx.dev/guides/health-checks.html)。Vite 已有 HMR，不要为同一源码变化再配置整个服务重启。

进程 ready 不等于 Pluxel 应用 ready 或业务配置已应用；使用下节的对应入口验证。重启后重新查询实例，旧操作仍以原 receipt [查询或取消](./dev-console.md#结果取消和恢复)。

### Agent 的日志与排障顺序

| 要确认的事实                                         | 入口                                              |
| ---------------------------------------------------- | ------------------------------------------------- |
| 服务是否存在、运行、监听及公开 URL                   | `pitchfork list/status`、`pitchfork proxy status` |
| 启动失败、Vite 编译错误、退出、stdout/stderr         | `pitchfork logs`                                  |
| 应用 ready、HMR 接纳、Plugin 状态与报告              | `pluxel dev status` 与控制台脚本                  |
| Plugin 业务日志、配置、方法、Workbench RPC、生命周期 | [开发控制台](./dev-console.md)                    |

先发现并复用已有服务；纯静态任务不启动服务。需要运行且服务未启动时，才用已注册 URL 或显式 `start`。启动失败先查进程日志；运行中跨文件或连续编辑先按 [HMR 批次控制](./dev-console.md#hmr-批次控制)暂停，检查后显式应用，再查应用报告和业务日志，不通过服务 restart 代替 apply。操作步骤、receipt 与交付证据见[控制台工作流程](./dev-console.md#coding-agent-工作流程)。只清理本任务启动且约定清理的服务，保留已有共享实例。

```sh
# 将 app 替换为发现的完整服务 ID
pitchfork logs app --since 5min -n 100 --no-pager
pitchfork logs app --since 5min --grep error -n 100 --json
pitchfork logs app --follow
```

记录操作时间，默认查有限窗口与条数；只为一次启动或复现短暂 follow，完成后结束订阅，不另起 Vite 捕获日志。`--grep error` 空结果不能证明没有失败；`--level` 依赖结构化日志配置，不能可靠筛选普通 Vite 文本。stdout 的零散输出不能代替控制台业务日志。

Pitchfork 日志可跨终端和 agent 会话查询，默认不自动清理，也不是无限期审计存储；按需在 `[settings.logs]` 设置 `time_retention` / `line_retention`，不要自建收集进程或清空其他任务日志。默认用 CLI，结构化集成确有收益时再接 [MCP](https://pitchfork.jdx.dev/guides/mcp) / HTTP API。日志参数见 [Logs](https://pitchfork.jdx.dev/guides/logs)。

### 并行 agent 与 Git worktree

每个 worktree 使用不同的目录末级名称，让 Pitchfork 派生不同 namespace；不要把同一个固定 `namespace` 提交到所有 checkout。跨目录操作使用 `pitchfork list` 返回的完整 daemon ID，避免停止别人的服务。相同目录名或显式 namespace 需要按[Namespaces 与 worktrees](https://pitchfork.jdx.dev/concepts/namespaces.html)配置隔离。端口由 Pitchfork 分配，业务数据目录、数据库和外部服务仍需应用自行隔离。

## 修改 hk 与 Pkl 配置

hk 2.6 内置 Pkl 求值器，执行检查不要求另装 Pkl CLI；需要独立学习或求值时可按 Pkl 官方文档安装。先读现有 `hk.pkl` 与锁定的 hk 版本，再按 [hk 配置参考](https://hk.jdx.dev/configuration.html)修改。`amends` 指向对应版本的 `Config.pkl`；版本升级时同步 schema URL，不能只换二进制。Pitchfork 使用 TOML，不需要把 `pitchfork.toml` 转成 Pkl。

Pkl 入门从 [hk Pkl essentials](https://hk.jdx.dev/pkl_introduction.html)开始，需要语言细节再读 [Pkl 官方教程](https://pkl-lang.org/main/current/language-tutorial/index.html)。LLM 配置时依次确认：

1. 继承的 schema 版本、已有 hooks/steps 和实际 package scripts。
2. `glob` / `exclude` 选择范围，以及命令是逐文件还是整仓检查；整仓命令不要按文件重复运行。
3. `check` 只读并以非零状态报告失败；`fix` 才能修改文件。文件列表参数和命令模板以所用 hk 版本为准。
4. 修改后执行 `hk validate`，再对实际文件运行相关检查，检查是否有遗漏或不必要的全仓执行。

hk 的提交 hook 可以暂存修复结果、保护未暂存修改；具体行为取决于 `hk.pkl` 与 hook 设置，见[配置参考](https://hk.jdx.dev/configuration.html)。不要在 step 内另写 `git add` 或自行管理 stash。共享规则只维护一份；需要本机扩展时使用 `hk.local.pkl` 并 `amends "./hk.pkl"`，避免替换掉共享配置。Agent 集成能力见 [hk Coding agents](https://hk.jdx.dev/agents.html)，按实际需要采用。

## 按需求查官方能力

只在需要时启用；新增进程管理脚本前先查原生能力：

- 工具与环境：[mise 入门](https://mise.jdx.dev/getting-started.html)；[mise Tasks](https://mise.jdx.dev/tasks/)是原生能力，本工作区任务仍统一在 package scripts / Vite Task。
- 服务依赖、环境与资源限制：[Pitchfork 配置](https://pitchfork.jdx.dev/reference/configuration.html)。端口、就绪、健康与日志见本页对应章节的官方链接。
- 文件监控、shell 自动启停、一次性任务、生命周期、调度、TUI、Web UI 和 API：[Pitchfork Guides](https://pitchfork.jdx.dev/guides/)；外部配置集成见 [mise integration](https://pitchfork.jdx.dev/guides/mise-integration.html)。默认使用 CLI。
- hooks、文件筛选、monorepo 与 CI：[hk 配置](https://hk.jdx.dev/configuration.html)、[hk CLI](https://hk.jdx.dev/cli/)。

上游参数以安装版本的帮助、配置验证和官方文档为准。
