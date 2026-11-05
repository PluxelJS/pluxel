---
title: 在线开发控制台
description: 控制现有 Vite 的 HMR 批次，提交 TypeScript 操作，检查应用状态、配置、Workbench 和日志，并恢复原操作结果。
---

Pluxel 开发控制台（Dev Console）运行在当前正在运行的 Vite 进程与宿主（Host）上下文中。它提供了在服务运行期间执行测试脚本、在线查看和修改配置、精准管理热模块替换（HMR）批次以及按条件筛选业务日志的能力。

<span id="coding-agent-工作流程"></span>

## 推荐工作流程

1. **确认服务与应用状态**：
   运行 `pluxel dev status` 确认当前 Vite 根目录、匹配的实例 ID、HMR 运行模式以及宿主就绪状态（`application.state`）。
2. **多文件连续修改时暂停 HMR**：
   若需修改多个代码文件，可执行 `pluxel dev hmr pause` 暂停自动热更新。在完成全部修改并通过类型检查后，执行 `pluxel dev hmr apply` 将改动作为一个批次统一提交。确认状态正常后执行 `pluxel dev hmr resume` 恢复自动模式。
3. **提交与执行交互式脚本**：
   在工作区内编写普通的 TypeScript 导出函数，通过 `pluxel dev run <path>` 提交执行。
4. **保存与查询操作回执**：
   对于耗时较长或后台异步执行的操作，系统会返回操作回执（Receipt）。可通过 `pluxel dev result <receipt>` 查询真实结果或通过 `cancel` 主动取消。

```sh
# 检查默认配置文件的服务状态
vp exec pluxel dev status

# 执行指定的开发调试脚本
vp exec pluxel dev run host/web/dev/inspect.ts

# 若使用前台 local 配置文件，显式携带 --profile 参数
vp exec pluxel dev status --profile local
```

<span id="hmr-批次控制"></span>

## HMR 批次控制

默认情况下，HMR 为 `auto` 自动更新模式。在需要跨多个文件连续重构代码、避免中间半成品状态频繁触发热更新时，可以通过批次控制命令显式编排：

```sh
# 1. 暂停自动更新
vp exec pluxel dev hmr pause

# 2. 编辑修改源码并完成静态检查

# 3. 统一应用当前批次的变更
vp exec pluxel dev hmr apply

# 4. 执行测试脚本确认应用状态
vp exec pluxel dev run host/web/dev/inspect.ts

# 5. 确认正常后恢复自动模式
vp exec pluxel dev hmr resume
```

### 命令说明

| 命令             | 行为说明                                                                        |
| :--------------- | :------------------------------------------------------------------------------ |
| `dev hmr pause`  | 将更新模式切换为 `paused`，后台文件监听器继续收集并合并文件变动                 |
| `dev hmr apply`  | 将当前积累的全部文件变动作为单个完整批次应用到宿主应用中，执行后仍保持 `paused` |
| `dev hmr resume` | 应用剩余的待处理改动并将模式切回 `auto`，后续变更恢复自动热更新                 |
| `dev status`     | 查看当前的 HMR 调度状态、是否有在途更新任务以及待处理文件数量                   |

`dev status` 中的 `hmr` 字段结构：

- `mode`：当前模式（`auto` 或 `paused`）；
- `running`：当前是否有正在执行的应用更新批次；
- `pending.files`：当前已累积的文件变动数；若超过 4096 个文件则自动标记为 `full: true` 执行全量重算；
- `observedRevision` / `attemptedRevision`：监听观察到的版本与已尝试更新的版本号。

## 编写可交互的开发脚本

在 `host/web/dev/inspect.ts` 中定义可执行函数：

```ts no-twoslash
import { defineDevConsole } from '@pluxel/host-vite/console'
import { TodoPlugin } from '@example/todo-plugin'

// 默认导出：直接执行状态检查
export default defineDevConsole(async (dev) => ({
	status: await dev.plugins.status(TodoPlugin),
	todos: dev.plugins.require(TodoPlugin).snapshot(),
}))

// 具名导出：支持接收外部参数执行操作
export const add = defineDevConsole(async (dev) => {
	if (typeof dev.input !== 'string') throw new TypeError('Expected a todo title')
	return dev.plugins.require(TodoPlugin).add(dev.input)
})
```

通过 CLI 触发执行：

```sh
# 执行默认导出
vp exec pluxel dev run host/web/dev/inspect.ts

# 执行具名导出并传入 JSON 参数
vp exec pluxel dev run host/web/dev/inspect.ts --export add --input '"测试待办事项"'
```

- 脚本内部可通过 `dev.plugins` 直接访问已加载的插件实例与运行状态。
- 函数返回值会被自动序列化为 JSON 格式在控制台输出。
- 修改脚本自身或添加新的具名导出无需重启 Vite 服务，控制台会自动热加载最新脚本。

<span id="项目入口与启动方式"></span>

## 配置 profile 与启动方式

在 `package.json` 的 `pluxel.dev` 节点中声明开发环境配置文件（Profile）：

```json
{
	"pluxel": {
		"dev": {
			"default": "app",
			"app": {
				"root": "host/web",
				"pitchfork": "app"
			},
			"local": {
				"root": "host/web",
				"command": "vp run @example/host#dev:server"
			}
		}
	}
}
```

- `default`：默认使用的 profile 名称；
- `root`：相对于当前包的 Vite 根目录；
- `pitchfork`：指定托管该服务的 Pitchfork 任务名；
- `command`：直接在前台启动的命令（与 `pitchfork` 二选一）。

<span id="编辑配置"></span>

## 在线查看与更新插件配置

在调试脚本中，可通过 `dev.config` 接口在线查询和修改插件配置：

```ts no-twoslash
export const increaseLimit = defineDevConsole(async (dev) => {
	// 读取当前配置快照
	const current = await dev.config.get(TodoPlugin)
	if (!current.ok) return current

	// 提交增量补丁，传入期望的修订号以防止并发冲突
	const result = await dev.config.patch(
		TodoPlugin,
		{ set: { maxItems: 100 } },
		{ expectedManagedRevision: current.managedRevision },
	)

	return { result, latest: await dev.config.get(TodoPlugin) }
})
```

- `dev.config.get(Plugin)`：返回包含 `managedInput`（原始持久化输入）、`effectiveInput`（生效输入）与版本修订号的完整数据。
- `dev.config.patch(Plugin, { set, remove })`：应用增量字段更新或删除特定配置路径。
- `dev.config.reset(Plugin)`：清除所有已保存的覆盖配置，恢复默认设置。

<span id="有界操作日志与等待"></span>

## 捕获与筛选运行时日志

通过 `Logging` 服务可实时读取特定插件的结构化日志流：

```ts no-twoslash
import { defineDevConsole } from '@pluxel/host-vite/console'
import { Logging, markLogs, readLogs } from '@pluxel/core/logging'
import { TodoPlugin } from '@example/todo-plugin'

export const restartWithLogs = defineDevConsole(async (dev) => {
	const logging = dev.ctx.require(Logging)

	// 1. 在操作前记录游标位置
	const cursor = markLogs(logging)

	// 2. 执行目标动作（如重启插件）
	const report = await dev.plugins.restart(TodoPlugin)

	// 3. 读取游标之后产生的相关日志
	const logs = readLogs(logging, cursor, {
		limit: 100,
		filter: { plugin: TodoPlugin.nodeAddress() },
	})

	return { report, logs }
})
```

- `markLogs(logging)`：捕获当前时刻的日志游标；
- `readLogs(logging, cursor, { limit, filter })`：根据游标与插件地址筛选出最新产生的有界日志记录。

<span id="结果取消和恢复"></span>

## 异步任务结果查询与取消

执行脚本时可传入 `--detach` 将任务放入后台执行并获取回执：

```sh
# 后台运行脚本
vp exec pluxel dev run host/web/dev/seed.ts --detach

# 使用返回的回执查询执行状态与结果
vp exec pluxel dev result <RECEIPT>

# 若任务执行时间过长，可根据回执主动取消
vp exec pluxel dev cancel <RECEIPT>
```

- 回执严格绑定当前的进程实例与运行 ID。
- 退出码说明：
  - `0`：任务成功完成；
  - `1`：脚本抛出异常或已被取消；
  - `2`：任务仍处于排队或执行中。
