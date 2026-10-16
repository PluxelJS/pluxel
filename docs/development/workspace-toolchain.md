---
title: 工作区工具链
description: 用 mise 固定工具、hk 执行提交检查、Pitchfork 管理开发服务，保持应用操作与进程管理边界清晰。
---

官方 monorepo 和 `@pluxel/create` 项目以 mise、Vite+、hk、Pitchfork 作为默认开发工作区。先按[快速开始](../getting-started/index.md)创建应用；本页用于准备 checkout、管理服务、调整检查，以及指导 coding agent 修改工具配置。生产交付见[应用交付](./distribution.md)。

## 每个工具维护什么

| 文件或工具                 | 职责                                                            |
| -------------------------- | --------------------------------------------------------------- |
| `mise.toml`                | 固定 Node、pnpm、Vite+、hk、Pitchfork 版本，配置环境变量和 PATH，不定义项目任务  |
| `vite.config.ts`           | Vite+ 的任务、pack、lint 与 fmt 入口；每份规则只有一个来源      |
| `pitchfork.toml`           | 用 **TOML** 声明长期服务、启动命令、分配端口与就绪条件          |
| `hk.pkl`                   | 用 **Pkl** 声明提交检查、文件选择和检查/修复命令                |
| `package.json` / Vite Task | package 声明依赖；Vite Task 声明命令、依赖图和缓存              |
| Pluxel dev console         | 在指定的现有 Vite 实例中读取或操作 Plugin、配置、报告和应用日志 |

mise 管理工具的安装和执行环境；package scripts 提供统一操作入口；Pitchfork 管理进程；hk 调用项目检查。不要在三份配置中分别实现同一个检查，也不要用新的后台脚本重做 Pitchfork 的端口、重试或日志管理。

## 构建、检查与任务图

Vite+ 的 `vp run` 执行原生任务图；`vp run verify` 用 `dependsOn` 组合治理、`vp check`、测试与构建，不再用 shell 串联多套检查入口。`vp check` 同时检查格式、lint 和类型；根 `vite.config.ts` 的 `fmt` 拥有格式规则，`lint.options.typeAware` 与 `typeCheck` 同时启用类型检查。`vp check --fix` 显式修复可自动处理的问题。上游入口见 [Check](https://viteplus.dev/guide/check)、[任务图与缓存](https://viteplus.dev/config/run)。

`vp pack` 是源码打包器；发布 tarball 使用 `vp pm pack`，两者不可互换。保留有领域价值的 `tsdown.config.ts` 与 `oxlint.config.ts`，由 `vite.config.ts` 的 `pack`、`lint` 引用。Plugin 构建仍使用 `pluxel build` 的编译语义。框架中依赖未构建编译插件的配置通过 `scripts/pack.mjs` 在依赖任务完成后调用 Pack API，避免任务发现提前加载产物。任务拥有实际命令、依赖顺序和缓存；根工作区在 `package.json` 保留 IDE 可发现的 `dev`、`build`、`test`、`check`、`verify` 等 scripts；构建、测试与验收入口委托给 `vite.config.ts` 中的 `workspace:*` 聚合任务；叶包保留标准 `build` / `test` / `typecheck` scripts，分别委托 `compile` / `check-tests` / `check-types`，供 source 发现与外部调用。

日常使用 `vp install`、`vp add`、`vp remove`、`vp exec` 和 `vp run`；Vite+ 按 `packageManager` 使用固定 pnpm。官方工作区有 catalog 分类政策，添加依赖使用 `vp exec pluxel pncat add <package>`，移除、迁移和清理同样使用 `pluxel pncat` 原生命令。`vp exec pluxel workspace sync` 只对齐已有 catalog 版本，不修改包依赖声明。pncat 负责依赖写入，Pluxel 负责自己的版本政策；不维护 `catalog:add` 一类重复脚本。参考 [Vite+ 包管理](https://viteplus.dev/guide/package-management)。

`vite` 依赖指向 Vite+ Core 的 npm alias；Core 使用自己的版本号，工作区通过精确的 `peerDependencyRules.allowedVersions.vite` 接纳该版本，避免将其误当成旧版 Vite。升级 Vite+ 时同步 mise 版本、`vite-plus` catalog、Vite alias 与此 peer 规则，并验证插件兼容性。

Vitest 继续提供测试契约；vendor 中参与根工作区的包按根任务图执行；未接入的第三方子项目保持各自工具配置，不递归改写整棵 vendor。新增任务先查看 [Vite Task 配置](https://viteplus.dev/config/run)，不要恢复另一套任务调度器。

框架仍保留独立的 `check-types` 任务：它们验证各包明确声明的 tsconfig、仅供编译的 API probes，以及额外的前端配置。`vp check` 的文件选择与这些检查不同，例如 `*.typecheck.ts` 不进入源码语义 lint；不能因为启用了原生类型检查就删除这些契约测试。普通下游项目可用 `vp check` 作为统一静态检查入口，只有存在额外类型契约时才增加独立任务。

测试和 benchmark 也必须属于明确的 TypeScript 项目。若包的打包配置只包含 `src`，在测试目录提供继承包配置的 `tsconfig.json`，显式设置 `noEmit: true`、`composite: false` 和测试所需环境类型；不要扩大生产声明构建的输入，也不要让测试落入缺少正确标准库的推断项目。`vp check` 会按文件发现就近的配置。

根 scripts 是人和 IDE 的入口，原生任务拥有依赖图与缓存，两者可以共存。Vite+ 支持通过 `run.cache.scripts: true` 缓存 package scripts，但默认关闭。本仓库和模板保留 `scripts: false, tasks: true`：入口每次执行，底层构建与测试任务按各自输入复用缓存，开发服务和验收检查不会被入口缓存跳过。不要同时定义同名 script 和原生 task；例如 `"build": "vp run workspace:build"` 对应原生 `workspace:build`。直接执行 `pnpm run build` 的 IDE 也会进入同一 Vite Task 图。简单项目可以直接使用 scripts 并启用缓存；有明确依赖、产物或环境规则时再使用原生 task，不能为了迁移而删除可发现的入口。

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

运行 `vp run deploy` 时，Vite Task 先完成构建与测试；多个任务依赖同一构建时共享该任务。不要在各命令中再次执行完整工作区 build。测试如果消费构建产物，在 test 上声明 `dependsOn: ['build']`；直接测试源码则无需这个依赖。同一个名称不能同时定义为 package script 和原生 task。官方模板保留标准 package scripts 作为 source 发现入口，委托给 `compile`、`check-tests` 等原生任务；新增 deploy 可直接定义为 task。

Monorepo 使用 `dependsOn: [{ task: 'build', from: ['dependencies', 'devDependencies', 'peerDependencies'] }]` 表达直接依赖的构建，或用 `@example/domain#build` 指定精确任务。这些引用应指向实际原生任务：官方模板内部使用 `compile` / `check-tests`，不重复经过供外部使用的 package script。框架仓库有合法的包依赖环，根任务通过明确的构建边组织顺序，不能简单用递归 package 排序代替。语法与嵌套任务行为见 [Vite Task](https://viteplus.dev/guide/run)。

标准 `vp build` 会自动报告输入、输出与相关环境变量，无需重复手写这些设置。组合 Pack、Pluxel 编译或自定义命令时，缓存需要覆盖真实契约：

- `input: [{ auto: true }]` 保留自动文件追踪；跨包共享配置可补充 `{ pattern: 'tsconfig.base.json', base: 'workspace' }`。不要排除构建实际读取的模板、声明、测试夹具或文档资源。
- `output` 声明可恢复的产物，例如 `dist/**`；测试通常使用 `[]`。每份产物只由实际生成它的任务归档，聚合任务不重复归档子任务的输出。
- `env` 声明影响结果的环境变量，例如 `CI`、`NODE_ENV` 和构建开关；密钥不能写进配置。自动环境追踪的适用范围见 [Automatic Data Tracking](https://viteplus.dev/guide/automatic-data-tracking)。
- 部署、发布、数据迁移、实时服务检查和外部集成测试使用 `cache: false`。URL 没变不能证明远端服务状态没变。官方模板的治理与完整验收入口每次执行，底层构建和单元测试仍复用缓存。

迁移后连续执行两次 `vp run verify`，检查第二次的 cache hit；再删除一个构建产物验证恢复，修改一个真实输入确认相应任务失效。`vp run --last-details` 显示上次执行细节；需要强制重跑使用 `--no-cache`。CI 持久化 `node_modules/.vite/task-cache`，避免每次 checkout 都失去缓存。完整配置参考 [Task Caching](https://viteplus.dev/guide/cache) 与 [run 配置](https://viteplus.dev/config/run)。

## 准备 checkout

先按 [mise 入门](https://mise.jdx.dev/getting-started.html)安装并激活 mise，再检查 checkout 的 `mise.toml`。在工作区根目录运行：

```sh
mise trust
mise install
mise exec -- vp install --frozen-lockfile
vp run
```

新生成项目尚无锁文件时，安装依赖使用 `mise exec -- vp install`。安装 hooks 是独立步骤：已有 Git 仓库运行 `vp run hooks:install`；新应用先决定并执行 `git init`，再安装 hooks。生成项目安装依赖后运行 `vp run setup` 接入 Pluxel 文档与开发资源，不要求已经初始化 Git。首次安装直接使用 `vp install`，不经过依赖项目配置的任务发现。信任配置后再执行安装，版本以该 checkout 的 `mise.toml` 为准。`mise.toml` 使用官方 `env._.path = ["node_modules/.bin"]`，让已安装项目优先使用自己的 Vite+ 与编译依赖；首次安装前才使用 mise 提供的入口。未激活 shell 的 CI 或 agent 使用 `mise exec -- <command>`。相对路径由 mise 按项目根解析，详见 [mise 配置路径](https://mise.jdx.dev/configuration.html#config-root)。

检查与修复分开执行：

```sh
mise exec -- hk validate
mise exec -- hk check --all
mise exec -- vp run verify
```

`vp run check` / `vp run fix` 执行全项目 Vite+ 检查与修复；只处理改动文件时直接运行 `hk check` / `hk fix`。`vp run verify` 执行完整门禁。

`hk check --all` 执行 hk 声明的全量检查；`vp run verify` 是完整交付门禁，包含仓库实际定义的治理、类型、测试和构建。提交前的增量检查不能替代完整门禁。需要自动修复时显式运行 `hk fix` 并审阅 diff。[hk CLI](https://hk.jdx.dev/cli/)说明文件选择和各命令参数。

## 进入工作区时的可选诊断

mise 的目录 hooks 属于环境生命周期，不需要恢复 `[tasks]`。已激活 mise 的交互 shell 可用 `hooks.enter` 提前提示工作区问题：从项目外进入时执行，在项目内部切换目录不重复执行；`hooks.cd` 则每次目录切换都执行，不适合重复扫描 source 图。新建或信任配置也可能触发 enter，详见 [mise Hooks](https://mise.jdx.dev/hooks.html)。

安装 CLI 并完成源码接入后，可在本机 `mise.local.toml` 中启用：

```toml
[hooks]
enter = 'pluxel source doctor --root "{{config_root}}"'
```

npm 消费项目改用 `pluxel workspace doctor --root "{{config_root}}"` 检查开发资源与工作区治理；不要对没有 source 接入的项目强加源码检查。显式 root 避免从子目录进入时检查错对象。首次 clone 尚无工具、依赖或 CLI 时先完成安装，再开启诊断；框架仓库尚未构建的 CLI 也不适合直接放进 enter。默认共享配置不安装该钩子。

钩子只触发既有只读检查，不重复实现解析或修复。`source doctor` 检查声明、checkout 和 overlay，不证明构建产物最新；`source install`、`source build`、`workspace setup` 与 `workspace sync` 仍显式执行，不能因为进入目录就安装包、修改文件或重建来源。检查失败保留诊断，随后按提示修复，不用 `|| true` 隐藏结果。

enter 依赖 shell activation，不能假定 IDE、CI、agent 的非交互命令或 `mise exec` 一定执行它。钩子失败会由 mise 显示警告，不是阻止后续操作的门禁；开发启动与交付流程中的必要检查仍保留。Agent 发现自动提示后应读取具体错误，不能将“进入目录没有报错”作为验证证据。

## GitHub Actions

本仓库通过 [mise-action](https://github.com/jdx/mise-action) 读取同一份 `mise.toml`，安装 Node、pnpm、Vite+、hk 和 Pitchfork。Action 使用上游持续维护的大版本标签，自动接收该大版本内的更新；`.github/dependabot.yml` 每周检查并分组提出跨大版本升级。Action 的版本与 `mise.toml` 中固定的工具版本是两层配置，更新 Action 不会自动升级项目工具。

[Vite+ 官方 setup-vp](https://github.com/voidzero-dev/setup-vp) 可负责 Vite+、Node、包管理器、依赖安装与依赖缓存，适合采用它统一初始化的 CI。本仓库已由 mise 管理这些工具，保留一个安装入口；Vite Task 结果缓存仍需单独持久化。若下游选择 setup-vp，按其官方要求使用精确发布版本并由 Dependabot 更新：它的 `@v1` 标签已冻结，不会跟随新版本。

[hk 官方 CI 指南](https://hk.jdx.dev/ci.html) 使用 mise 安装工具后直接运行 `hk validate` 和 `hk check --all`，无需安装 Git hooks。本仓库的完整门禁由 Vite Task 执行 `vp check`、类型检查、测试与构建，hk 复用相同检查器处理本地提交文件，避免 CI 重复执行全量检查。

## 管理开发服务

先读 `pitchfork.toml`，再检查 `pitchfork list`，确认当前目录、namespace 与已有进程。生成应用的 daemon 名为 `app`；框架仓库的示例宿主名为 `plugin-host`，文档站名为 `docs`。`vp run dev` 选择对应工作区的默认服务，框架仓库另有 `vp run docs`。以下以生成应用为例，在框架仓库将 `app` 替换为对应名称：

```sh
pitchfork start app
pitchfork status app
pitchfork logs app
pitchfork restart app
pitchfork stop app
pitchfork wait app
```

`start` 等待配置的就绪条件，服务随后由 supervisor 管理；命令退出不代表服务停止。`wait` 等待服务停止，不用于等待就绪。修改配置后针对目标服务重启，结束工作时停止自己启动的服务。命令细节先查 `pitchfork --help`、`pitchfork <command> --help` 和 [CLI Reference](https://pitchfork.jdx.dev/cli/)。

根 `dev` script 执行 `pitchfork start <service> && pitchfork status <service>`，启动成功或复用已有服务后都显示当前状态、端口和真实代理 URL；文档站入口采用同样方式。地址由 Pitchfork 的状态输出提供，无需重新打印 Vite 启动日志。Pitchfork 的 `run` 调用应用包的 `dev:server` script，后者拥有实际 Vite 启动命令。不要再经过 mise task，也不要让 `dev:server` 回调根 `dev`。`mise = true` 只为服务加载项目工具环境。根 `dev:status`、`dev:logs`、`dev:stop` 是 IDE 可发现的常用操作；其他服务管理直接使用 Pitchfork CLI，不为每个子命令增加包装。前台调试入口按下节操作，不与同一个托管服务同时运行。

### 按访问启动与服务复用

保留 Pitchfork 的目的是让开发服务、稳定 URL 和进程日志独立于某个终端或 agent 会话。Agent 复用已运行的服务，不为获取日志再开一个 Vite。需要前台 Vite 交互时使用下节的直接调试入口；后台服务不承载 Vite 的 `h/o/r` 键盘会话。

代理启用且项目已被发现后，访问已停止 daemon 的代理 URL 会启动它及其 `depends` 依赖。首次 checkout 仍需安装工具和项目依赖；supervisor/代理必须已运行，项目必须已注册或至少启动过一次。默认入口 `vp run dev` 完成显式启动；仅切换目录不会注册项目。不要手工拼域名，先从 `pitchfork list --json`、`pitchfork status app --json` 或 `pitchfork proxy status` 取得实际 URL。只访问本任务所属服务：访问停止服务的 URL 本身会触发启动及依赖命令。

首次请求等待服务启动后转发；并发请求可能收到自动刷新的启动页。依赖失败会返回错误；收到 HTTP 响应或启动页不能证明 Pluxel 应用 ready。自动启动默认等待 30 秒，超时后后台启动仍会继续。当前模板和仓库的 `ready_output.timeout` 为 5 分钟，它不改变代理的等待预算；冷构建耗时较长时优先显式 `pitchfork start app` 等待就绪，或按实际需求配置 `settings.proxy.auto_start_timeout`。不要因首次请求超时重复启动进程或自行添加轮询器。

按需启动不等于默认自动停止：空闲停止默认关闭，可按需配置 `proxy.idle_timeout`。经代理保持打开的 Vite HMR WebSocket 会计入活动；显式 CLI 启动的服务不受代理空闲停止控制。依赖顺序、并发启动与空闲回收使用 Pitchfork 原生能力，详见 [Auto-Start](https://pitchfork.jdx.dev/guides/port-management#auto-start) 和 [Idle Shutdown](https://pitchfork.jdx.dev/guides/port-management#idle-shutdown)。Redis 等普通 TCP 服务可以作为依赖启动，但客户端仍直连其端口，不经过 HTTP 反代。

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

**已有 supervisor 的一次性迁移：** 代理设置在共享 supervisor 启动时读取，后来进入另一个项目不会重新配置它。先通过 `pitchfork list` 检查已有服务；需要采用本项目设置时，在项目根目录显式运行 `pitchfork supervisor start --force`，然后重新启动所需服务。日常 `dev` 不强制重启共享 supervisor。用 `pitchfork proxy status` 确认实际公开地址；若 `8088` 被其他程序占用，先解决冲突。相同配置的项目共享同一个代理，无需为每个应用启动独立代理或修改用户配置。详见[设置加载规则](https://pitchfork.jdx.dev/reference/settings.html#when-changes-take-effect)。

Pitchfork 2.30.1 的路由表有约两秒缓存；第二个项目刚注册后立即请求可能短暂返回 `Unknown project`，稍后刷新即可。服务 ready 与代理路由缓存更新是不同的完成条件。

Pluxel 的开发地址契约与代理供应商分开：

| 输入                                    | 用途及优先级                                     |
| --------------------------------------- | ------------------------------------------------ |
| `PLUXEL_PUBLIC_ORIGIN`                  | 显式 HTTP(S) 公开 origin，优先于自动集成输入     |
| `PITCHFORK_URL`                         | Pitchfork 提供的公开 URL；没有显式 origin 时采用 |
| `PLUXEL_HOST_BIND` / `PLUXEL_HOST_PORT` | 显式监听地址和端口，分别优先于 `HOST` / `PORT`   |
| `HOST` / `PORT`                         | 通用进程监听输入，未启用代理也可使用             |

公开 origin 用于终端 `Application` / `Workbench` 地址与管理会话同源校验；实际 listener 地址保持物理地址。没有公开 origin 时显示 Vite 本地地址。Pluxel 不通过任意请求的转发头猜测可信 origin。切换其他反代时设置 `PLUXEL_PUBLIC_ORIGIN`，并让反代转发 HTTP 与 Vite WebSocket；这个变量本身不会建立代理路由或配置证书。直接调试 Vite 时，先停止对应的托管服务，再运行生成应用的 `vp run @example/host#dev:server` 或框架仓库的 `vp run @pluxel/plugins-host#dev:server`，避免混淆两个实例。

### 就绪、健康与应用操作

开发服务的就绪检查应该验证实际可用的入口；TCP 监听只证明端口可连接。多个 `ready_*` 条件是“任一成功”，需要全部满足时合并到一个 `ready_cmd`。就绪检查用于启动依赖，持续健康检查另行按需配置，见[就绪检查](https://pitchfork.jdx.dev/guides/ready-checks.html)和[健康检查](https://pitchfork.jdx.dev/guides/health-checks.html)。Vite 自身已有热更新，不必为同一源码变化再配置整个服务重启。

Pitchfork `logs` 用于进程启动、退出和 stdout/stderr 排障。查询 Pluxel 应用日志、配置、Plugin 方法、Workbench RPC 或 Plugin 生命周期，仍必须走[在线开发控制台](./dev-console.md)：先发现实例，再固定绝对 `--root` 与准确 `--instance`。Pitchfork 显示 running 或 ready 不能证明某次业务配置已经应用；重启进程后需要重新发现实例。

### Agent 的日志与排障顺序

| 要确认的事实                                             | 首选入口                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------- |
| 服务是否存在、运行、监听及公开 URL                       | `pitchfork list`、`pitchfork status`、`pitchfork proxy status` |
| 启动失败、Vite 编译错误、进程退出、stdout/stderr         | `pitchfork logs`                                               |
| 当前应用是否 ready、HMR 是否接纳、Plugin 状态与应用报告  | dev console 实例发现及控制台脚本                               |
| Plugin 业务日志、配置读写、方法、Workbench RPC、生命周期 | 固定 root/instance 的 dev console                              |

Agent 按以下顺序操作：

1. 读取目标 checkout 的 `pitchfork.toml`，用 `pitchfork list` 确认完整服务 ID、目录和已有状态。复用目标实例，不停止其他任务的服务。
2. 需要运行验证而目标未运行时，通过已注册的公开 URL 唤起，或显式 `pitchfork start`。启动失败先查看该服务的有限时间窗口日志；无需运行验证的纯静态任务不启动服务。
3. 服务启动后按[控制台指南](./dev-console.md)发现 Vite 实例，确认 `application.state`；后续调用固定绝对 root 与准确 instance。重启后重新发现，不沿用旧 instance。
4. 修改后先利用 Vite HMR，再检查应用报告及相关日志。只有实际需要重启时才用 `pitchfork restart`；进程 running、URL 可访问与业务修改生效分别验证。
5. 交付说明实际观察的服务、实例、结果及未验证边界；结束时按任务约定清理自己启动的临时服务，保留原有共享实例。

以下以生成项目的 `app` 为例；框架仓库使用 `plugin-host`，跨目录操作替换为发现的完整 ID：

```sh
pitchfork logs app --since 5min -n 100 --no-pager
pitchfork logs app --since 5min --grep error -n 100 --json
pitchfork logs app --follow
```

默认按时间和条数查询，避免每次读取全部历史；记录操作时间，再查相应窗口。仅在等待一次启动或复现时短暂 follow，完成观察后结束订阅，不必让 agent 一直占用长运行命令。`--grep error` 只是筛选文本，空结果不能证明没有失败。`--level` 需要服务配置结构化日志格式，普通 Vite 文本不能据此可靠筛选级别。业务日志仍经 dev console 读取，stdout 中的零散输出不能代替应用日志查询。

日志由 Pitchfork 保存，可跨终端和 agent 会话查询；它不是无限期审计存储。默认不自动清理，长期使用可按需在 `[settings.logs]` 配置 `time_retention` / `line_retention`，不自行增加 tail 文件、日志收集进程或清空其他任务日志。CLI 默认足够；只有结构化集成有明确收益时再使用 MCP/HTTP API。详见 [Logs](https://pitchfork.jdx.dev/guides/logs) 与 [MCP](https://pitchfork.jdx.dev/guides/mcp)。

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

下面是可用能力入口，不是要求全部启用的清单。新增进程管理脚本前，先确认 Pitchfork 是否已经提供对应功能。

| 需求                                                   | 官方文档                                                                                                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 固定工具、环境与任务                                   | [mise 入门](https://mise.jdx.dev/getting-started.html)、[mise Tasks](https://mise.jdx.dev/tasks/)                                                                                     |
| 服务依赖、环境与资源限制                               | [Pitchfork 配置参考](https://pitchfork.jdx.dev/reference/configuration.html)                                                                                                          |
| 端口分配、冲突、稳定 URL 与 HTTPS                      | [Ports & reverse proxy](https://pitchfork.jdx.dev/guides/port-management)                                                                                                             |
| 就绪、健康、恢复与日志                                 | [Ready checks](https://pitchfork.jdx.dev/guides/ready-checks.html)、[Health checks](https://pitchfork.jdx.dev/guides/health-checks.html)、[Guides](https://pitchfork.jdx.dev/guides/) |
| 文件监控、shell 自动启停、一次性初始化、生命周期与调度 | [Pitchfork Guides](https://pitchfork.jdx.dev/guides/)                                                                                                                                 |
| 外部配置、配置模板、mise 集成                          | [mise integration](https://pitchfork.jdx.dev/guides/mise-integration.html)、[Pitchfork Guides](https://pitchfork.jdx.dev/guides/)                                                     |
| TUI、Web UI、MCP 与 HTTP API                           | [Pitchfork Guides](https://pitchfork.jdx.dev/guides/)；默认先用 CLI，结构化操作有明确收益时再接 API                                                                                   |
| hooks、文件筛选、monorepo 与 CI                        | [hk 配置](https://hk.jdx.dev/configuration.html)、[hk CLI](https://hk.jdx.dev/cli/)                                                                                                   |

本页解释 Pluxel 的接入边界。上游参数和能力会变化，实际操作以安装版本的帮助、配置验证与官方文档为准。
