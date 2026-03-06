# HMR Behavior (Config-Driven)

这份文档描述 `@pluxel/hmr` 在“工作区 profiles + JSONC 配置”模式下的行为边界，重点是正确性与可预期性。

## 启动输入

- 配置文件：`pluxel.hmr.jsonc`（JSONC，**严格校验**，未知字段会报错）。
- profile 选择：优先级为 `PLUXEL_HMR_PROFILE`（或 `startHmrHostFromConfig({ profile })`）> 配置中的 `profile`。
- 启动方式：
  - CLI：`pluxel hmr start|doctor|prompt ...`
  - 非 CLI：`@pluxel/hmr/host` 的 `startHmrHostFromConfig()` 或 `createHmrHostFromConfig()`
  - 最底层：`createHmrHost({ workspaceSnapshot })` / `startHmrHost({ workspaceSnapshot })`（host 不做 discovery）

## JSONC 字段语义（V1）

- `defaults.roots` / `profiles.<name>.roots`
  - `auto`：从 workspace 信息推导扫描 roots（用于“发现包/发现插件入口”）。
  - `string[]`：指定扫描 roots（workspace 相对路径或绝对路径）。
- `profiles.<name>.enabled`
  - “要作为插件入口加载”的 package name 列表。
  - 会解析每个包的 `exports["."]["@pluxel/hmr"]`（或等价入口）作为启动 entry。
- `profiles.<name>.builtin`
  - 仅用于 discovery/entry 解析阶段的“排除列表”，避免 builtin 被同时作为 workspace entry 再加载一次。
- `include` / `exclude`
  - `include`：额外的“非 package entry”入口（例如 demo 文件）。
  - `exclude`：扫描/发现阶段的排除 glob（默认排除 `node_modules/dist/.turbo/*.map` 等）。

## Diagnose → Snapshot（关键边界）

`diagnoseWorkspace()` 会输出 snapshot（核心字段）：

- `enabledEntries`
  - 冷启动时会被执行的入口模块列表：
  - `enabled` 插件包入口 + `include` 解析到的实际文件。
- `watchRoots`
  - host 启动时传给 `hmrService.roots` 的 roots。
  - 目前策略是：`enabled` 插件包目录 + `include` entry 所在目录/包目录（最小化监听范围）。
- `includeGlobs` / `excludeGlobs`
  - 传入 HMRService，用于扫描/过滤与执行候选集治理（不是“硬隔离沙箱”）。

> 重要：Host **不再自己做 discovery**，这保证了“启动输入是确定的”。想要变更 entry 集合，必须改 JSONC 并重新 `diagnose`（CLI 或调用方负责）。

## 变更会不会影响运行中的插件

结论：**“不在 jsonc 里”并不等价于“完全不会影响”**，要分两层看。

1. **插件入口层（是否会被当作插件加载）**
- 一个 workspace 包不在 `enabled`/`include` 里：它的 `@pluxel/hmr` 插件入口不会被加载，因此它的插件 ctor/生命周期不会参与本次 host 运行。
- 这层是“严格的”：不在 entry 集合里，就不会作为插件被加载。

2. **模块依赖层（是否会影响已加载插件的运行结果）**
- 只要某个已加载的 entry（enabled 插件或 include 模块）**import 了**其他包/文件，那么这些依赖模块就会进入 Vite/runner 的模块图。
- 这些依赖模块即使不是“插件包”，它们的代码变更也可能触发重新评估，从而影响上游插件行为。
- 反过来：一个包既不在 entry 集合里、也没有被任何 entry 导入，那么它的变更不会影响当前运行（没有被执行/没有进入模块图）。

换句话说：
- `enabled/include` 决定“哪些东西会被当作插件入口执行”。
- “是否影响运行”取决于“是否进入模块图”（被入口或其依赖链实际 import）。

## 多项目并行启动（互不干扰的前提）

多项目同时启动一般不会互相干扰，前提是：

- 端口不同：为每个项目设置不同的 `PLUXEL_HMR_PORT`（或在代码里指定 `hmrService.port`）。
- 存储文件不冲突：同一 root 下同时跑多个 profile 时，确保 config 存储路径按 profile 分流（默认就会落到 `config.<profile>.json`；`store.configFile` 也支持 `{profile}` 模板）。
- 不要在同一个 Node 进程里用默认 `chdir` 同时创建多个 host（嵌入式场景用 `chdir:false`）。

