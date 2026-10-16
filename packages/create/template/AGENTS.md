# Coding agent 工作入口

开发 Pluxel 应用或插件前先使用 [pluxel-development skill](.agents/skills/pluxel-development/SKILL.md)，由 skill 指导工具选择、开发服务、日志和在线操作；只按当前任务展开其引用文档。

入口缺失时：Git 用户从上游 checkout 的 CLI 执行 `source install --root <本项目>`；npm 用户安装依赖后执行 `vp exec pluxel workspace setup`。`vp exec pluxel docs` 可直接读取当前来源的正文。CLI 管理生成链接，不复制或提交上游正文。

完成修改后运行 `vp run verify`，报告实际检查结果与未验证边界；在线效果需要现有 dev console 的实际证据。

## 本项目位置与检查

- `host/src/app.ts` 是开发与生产共用的应用声明；可选 `sources` 扩展固定 catalog。默认 modules 构建与原生 `start.mjs` 只在启动接纳预编译来源；开发 Vite 持续更新。生产 Vite 使用独立 `vite.runtime.config.ts` 与 `start-vite.mjs`，加载同一 compiled factory。
- 浏览器 React/Vite 代码位于 `host/web/`；Node catalog、配置和路由策略位于 `host/`；共享中立逻辑位于 `packages/`。
- inspect 选择本应用时使用 workspace-relative `application: { root: 'host', entry: 'src/app.ts' }`。
- 修改 `plugins/`、公共契约、Host 配置或 `oxlint.config.ts` 前，按开发指南确认对应契约。应用装配见 `vp exec pluxel docs host/configuration.md`。
- 完成后运行 `vp run verify`；不得无理由绕过 Pluxel lint 规则。

插件范式按需读 `docs/pluxel/plugin-development/`；Host 装配读 `docs/pluxel/host/configuration.md` 的对应章节。已知目标直接定位，不把目录当作通读清单。

## 工作区工具与服务

先读 `docs/pluxel/development/workspace-toolchain.md`（或 `vp exec pluxel docs development/workspace-toolchain.md`）。`mise.toml` 只配置工具版本、环境和 PATH，package scripts 提供项目操作入口，Vite+ 执行任务图、打包、lint 和格式化，`hk.pkl` 定义检查，`pitchfork.toml` 声明 `app` 服务。首次运行 `mise trust`、`mise install`、`vp install`、`vp run setup`；已有 Git 仓库再运行 `vp run hooks:install`。

修改服务前先读现有配置、运行 `pitchfork list` 和 `pitchfork status app`，按需查询 `pitchfork <command> --help` 与官方文档。用 `vp run dev` 启动或复用并显示当前应用与 Workbench 地址（项目 CLI 的 `dev`；`package.json` 中 `pluxel.dev.default` 选择 `app`，`pluxel.dev.app` 声明 `root: host/web` 与 `pitchfork: app`）；用原生 stop、restart、logs 管理，不手写后台进程、端口探测、轮询或 supervisor。命名空间默认由目录决定，保留 Git worktree 隔离。Vite 已拥有 HMR，不重复配置进程级源码 watch。

`vp run dev:local` 使用内置 `local` profile 在相同 `host/web` root 前台启动，Ctrl+C 停止；控制台操作也加 `--profile local`，不使用默认 app 的归属。模板没有文档站，不声明无实际服务的 docs profile。

服务与日志操作遵循工作区指南的“按访问启动与服务复用”和“Agent 的日志与排障顺序”：

- 复用现有服务；已注册项目可访问真实代理 URL 唤起，首次 checkout 仍需准备依赖并注册或启动。访问 URL 会启动服务和依赖；不要猜域名或把启动页当作应用 ready。
- 启动失败、Vite 编译错误、进程退出和 stdout/stderr 使用 `pitchfork logs app --since 5min -n 100 --no-pager`。跨目录先发现完整服务 ID；仅为具体观察短暂使用 `--follow`，不另起进程收集日志。
- 应用状态、HMR 接纳、Plugin 业务日志、配置、方法和 Workbench RPC 使用 `docs/pluxel/development/dev-console.md` 指导的控制台。用 `vp exec pluxel dev status` 确认 `host/web` 的实例与应用状态，再用 `dev run host/web/dev/<script>.ts` 操作。控制台不调用 Pitchfork；显式 `--profile` 优先于 default，再选择唯一 profile，匹配实例仍有多个时显式 `--instance`，跨目录用 `--root` 选择配置发现起点；保存 receipt 用于 `dev result/cancel`，旧操作不转投重启后的实例。不能用进程 running 代替业务结果。
- 普通源码修改先利用 HMR；按需启动不等于自动空闲停止。只清理本任务启动的临时服务，保留原有共享实例。冷启动和日志保留策略按工作区指南及已安装 CLI 帮助配置。

`hk check` 检查改动文件，`hk fix` 显式修复；完整验收用 `vp run verify`。修改 Pkl 后运行 `hk validate`，修改服务配置后运行 `pitchfork daemons --json` 并验证实际服务。运行中 Pluxel 操作通过现有 dev console；`--root` 不绕过已发现配置，`--instance` 不绕过 profile 归属。

`vp run build` 通过 Vite Task 调度各包的标准 `build` 入口（委托 `compile` task）；`vp run verify` 组合治理、`vp check`、测试和构建。根 `package.json` scripts 保留 IDE 可发现的开发、构建、测试和检查入口；聚合 scripts 委托给 `workspace:*` 原生任务，入口不缓存，底层任务按各自规则缓存。根 `vite.config.ts` 拥有 `fmt` 与启用类型检查的 `lint`；包配置拥有任务、依赖和缓存。原生 `tsdown.config.ts` 通过 `pack` 引用，Plugin 构建继续使用 `pluxel build` 的编译语义。依赖操作使用 `vp exec pluxel pncat`，版本对齐使用 `vp exec pluxel workspace sync`；不要添加重复的 catalog 脚本。
