---
title: 工作区工具链
description: 用 mise 固定工具、hk 执行提交检查、Pitchfork 管理开发服务，保持应用操作与进程管理边界清晰。
---

官方 Monorepo 与 `@pluxel/create` 脚手架默认集成了 mise、Vite+、hk 与 Pitchfork 作为统一的本地开发工具链。本页介绍工具链各组件的分工、构建与测试任务调度、服务管理及排障方法。

<span id="每个工具维护什么"></span>

## 工具与配置分工

| 配置文件 / 工具            | 职责说明                                                                              |
| :------------------------- | :------------------------------------------------------------------------------------ |
| `mise.toml`                | 统一固定 Node.js、pnpm、Vite+、hk 与 Pitchfork 版本，配置环境变量和 PATH              |
| `vite.config.ts`           | 声明 Vite+ 任务图（Run Tasks）、打包规范（Pack）、代码检查（Lint）与格式化（Fmt）规则 |
| `pitchfork.toml`           | 声明后台长驻服务、启动命令、代理端口与就绪检查条件                                    |
| `hk.pkl`                   | 声明基于 Pkl 的 Git 提交前检查（Pre-commit Hooks）与自动化修复指令                    |
| `package.json` / Vite Task | 管理 npm 依赖与标准操作脚本；Vite Task 负责任务依赖图拓扑与增量执行缓存               |
| Pluxel Dev Console         | 运行期交互控制台：控制 HMR 批次、动态执行脚本、修改插件配置并查询运行时日志           |

<span id="构建检查与任务图"></span>

## 构建、检查与任务图

在 Pluxel 工作区中，`package.json` 的 scripts 提供了开发者和 IDE 的通用入口，而实际的命令调度、依赖关系拓扑与产物缓存则由 Vite Task 统一管理：

- **聚合任务**：根目录下的 `build`、`test`、`verify` 委托执行 `workspace:*` 聚合任务，依据 `pnpm-workspace.yaml` 中的实际成员进行自动拓扑编排。
- **叶子包标准任务**：各子包的 `build`、`test`、`typecheck` 分别映射到 `compile`、`check-tests`、`check-types`。
- **缓存策略**：默认启用 `tasks: true` 缓存模式。当源码输入未发生变动时，底层构建与测试会自动复用缓存结果；日常开发服务与集成验收则始终实时执行。

常用检查命令：

- 静态检查：`vp check`
- 自动修复代码格式与可修复 Lint：`vp check --fix`
- 完整门禁验证（包含类型、代码规范、测试与全量构建）：`vp run verify`

<span id="下游迁移到-vite-task"></span>

## 声明 Vite Task 任务

在项目的 `vite.config.ts` 中通过 `run.tasks` 声明命令、前后依赖与输出缓存：

```ts
import { defineConfig } from 'vite-plus'

export default defineConfig({
	run: {
		tasks: {
			build: { command: 'vp build' },
			test: {
				command: 'vp test run',
				cache: {
					input: [{ auto: true }],
					output: [],
					env: ['CI', 'NODE_ENV'],
				},
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

- **任务依赖**：使用 `dependsOn: ['build', 'test']` 确保依赖任务先执行。在 Monorepo 中，可通过 `dependsOn: [{ task: 'build', from: ['dependencies'] }]` 自动按包依赖图顺序构建前置包。
- **缓存声明**：`input` 声明影响任务结果的输入文件模式（`auto: true` 自动追踪）；`output` 声明该任务生成的交付产物（如 `dist/**`）。

<span id="准备-checkout"></span>

## 准备本地开发环境

初次克隆仓库后，按以下步骤初始化工具链：

```sh
mise trust
mise install
mise exec -- vp install --frozen-lockfile
vp run
```

常用验证命令：

| 检查目标              | 执行命令        | 说明                                     |
| :-------------------- | :-------------- | :--------------------------------------- |
| 验证 hk 配置有效性    | `hk validate`   | 校验 `hk.pkl` 语法与规则声明             |
| 检查 Git 暂存改动文件 | `hk check`      | 仅检查本次准备提交的文件                 |
| 全项目静态检查        | `vp run check`  | 对全工作区执行静态分析与类型检查         |
| 完整交付门禁          | `vp run verify` | 执行格式化、静态检查、单元测试与全量构建 |
| 自动修复暂存文件      | `hk fix`        | 对当前改动执行格式化与安全修复           |

<span id="github-actions"></span>

## GitHub Actions CI 配置

CI 环境通过 [mise-action](https://github.com/jdx/mise-action) 依据 `mise.toml` 统一安装工具：

- 执行 `vp run --concurrency-limit=2 workspace:ci` 运行全仓核心治理、代码格式化、类型检查与子包测试。
- 持久化保存 `node_modules/.vite/task-cache` 目录以实现跨工作流的构建结果缓存。
- 涉及端到端页面与 Worker 存储回归的测试，可在安装依赖后使用 Playwright 进行验证。

`workspace:ci` 不编译 Typst 原生库；Typst、Takumi Markdown、示例 Plugin Host 和 Typst Agent Workspace 的完整验收由本地 `vp run verify` 执行。CI 保留 Typst WASM、预览和源码定位的短测试。QuickJS 与 Electron 应用已迁入 [Pluxel Lab](https://github.com/PluxelJS/lab)，由该仓库维护构建、测试与 CI。

文档站的 `prepare:docs` 为示例类型检查准备包产物，Typst 使用 `compile-lib`，Takumi Markdown 使用不依赖原生编译的 `compile`。Vercel 安装入口的 Vite+ 版本须与 `mise.toml` 和 catalog 一致。

<span id="管理开发服务"></span>

## 管理后台开发服务（Pitchfork）

工作区使用 [Pitchfork](https://pitchfork.jdx.dev/) 托管本地长驻服务（如应用后端、文档服务）：

```sh
# 启动指定服务（服务名在 pitchfork.toml 中定义，如 app 或 docs）
pitchfork start app

# 查看服务状态与监听端口
pitchfork status app

# 查看服务标准输出与日志
pitchfork logs app

# 重启或停止服务
pitchfork restart app
pitchfork stop app
```

<span id="端口与公开地址"></span>

## 端口与公开反向代理

默认情况下，Pitchfork 内置轻量级本地 HTTP 反向代理，统一监听 `8088` 端口：

- 不同项目依据子域名进行路由转发，例如 `http://app.my-project.localhost:8088`。
- 应用进程自身在随机端口监听，由 Pitchfork 分配并通过 `PORT` 环境变量传入 Vite。
- 环境变量优先级：
  1. `PLUXEL_PUBLIC_ORIGIN`：显式指定的公开访问 URL；
  2. `PITCHFORK_URL`：Pitchfork 自动注入的本地反代 URL；
  3. `HOST` / `PORT`：物理监听端口与地址。

<span id="agent-的日志与排障顺序"></span>

## 日志与问题排查顺序

排查开发环境问题时，建议遵循以下顺序：

| 排查目标                   | 工具 / 命令                              | 说明                                              |
| :------------------------- | :--------------------------------------- | :------------------------------------------------ |
| 确认服务状态与访问端口     | `pitchfork list` / `pitchfork status`    | 检查进程是否处于运行状态及实际公开访问地址        |
| 排查服务崩溃或编译失败     | `pitchfork logs app --since 5min -n 100` | 查看 Node.js 进程报错、未捕获异常与构建日志       |
| 确认应用就绪与 HMR 状态    | `pluxel dev status`                      | 查看当前 Vite 实例、插件加载状态与 HMR 批次状态   |
| 查看插件业务日志与调用追踪 | [开发控制台](./dev-console.md)           | 在线查看插件日志、调用 RPC 方法及执行临时测试脚本 |

<span id="修改-hk-与-pkl-配置"></span>

## 配置 Git Hooks 与 hk

Git 提交前检查由 `hk.pkl` 驱动。每次修改规则后，先运行 `hk validate` 确保配置有效：

- `check`：只读检查，以非零状态码阻断不合规提交；
- `fix`：自动修复命令，支持修改文件并重新暂存。
- 若需添加个人专用的本地 Hook，可创建 `hk.local.pkl` 并通过 `amends "./hk.pkl"` 继承公共配置。
