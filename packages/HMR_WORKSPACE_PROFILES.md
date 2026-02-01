# @pluxel/hmr：Workspace Profiles 配置（v1）

## 目标
- 启动时总能拿到工作区最新插件入口（不引入 `sync`/索引产物）。
- 只有 `enabled` 插件进入 watch/compile/replace；未启用插件不承担成本。
- 配置只暴露：`roots / enabled / exclude / profiles`；**禁止** `include`（schema 不提供，解析严格拒绝）。
- 发现逻辑只实现一次：`@pluxel/cli` 提供运行时库，`@pluxel/hmr` 复用；用 `profiles` 切换策略。

## 兼容性约束（必须保持 @pluxel/hmr 既有正确性）
- 外置 discovery 只负责把 `enabled` 映射为“入口文件列表”，不得改变 `@pluxel/hmr` 的 loader/pipeline 语义。
- `@pluxel/hmr` 既有的 workspace 兼容性（跨 workspace 导入/包根定位/路径归一化/缓存等）必须保留；discovery 只是输入。

## 配置文件（放在运行目录）
- 默认路径：`pluxel.hmr.jsonc`（位于 `process.cwd()`）
- **@pluxel/hmr 在找不到配置文件时必须直接报错并拒绝启动**
  - `pluxel hmr` prompt 入口负责缺失时创建，再启动 `@pluxel/hmr`。

## 配置文件格式与修复策略（必须澄清）
- 默认生成 **JSONC/JSON5**（可注释/尾逗号），便于可读与机器生成。
- 允许手改，但生成文件头部必须注释提示：**推荐用 `pluxel hmr` prompt 修改**（避免语义/格式漂移）。
- 解析失败处理：
  - `@pluxel/hmr`：必须报错退出（不得覆盖文件）。
  - prompt：用户确认后备份为 `pluxel.hmr.jsonc.bak.<timestamp>` → 重新生成 → 继续交互/启动。

## Schema（v1）
> 解析必须 `strict`：未知字段直接报错（重点是拒绝 `include`）。

```ts
export type PluxelHmrConfigV1 = {
  version: 1
  profile: string
  defaults?: {
    roots?: "auto" | string[]
    exclude?: string[]
  }
  profiles: Record<
    string,
    {
      roots?: "auto" | string[]
      enabled: string[]
      exclude?: string[]
    }
  >
}
```

## 示例
```json
{
  "version": 1,
  "profile": "dev",
  "defaults": {
    "roots": "auto",
    "exclude": ["**/node_modules/**", "**/dist/**", "**/.turbo/**", "**/*.map"]
  },
  "profiles": {
    "dev": {
      "enabled": ["pluxel-plugin-kook", "pluxel-plugin-cmd-catalog"]
    },
    "minimal": {
      "enabled": ["pluxel-plugin-cmd-catalog"],
      "exclude": ["plugins/websocket/**"]
    }
  }
}
```

## 工作区插件发现（统一由 @pluxel/cli 提供运行时库）
### 识别规则（最小且稳定）
将一个工作区包视为“可被 HMR 加载的插件包”，当且仅当：
- `package.json.name` 存在
- `package.json.exports["."]["@pluxel/hmr"]` 存在且为字符串路径（源码入口）

> 发现阶段只读取 `package.json`，不扫描源码。

### 建议的发现 API（供 @pluxel/hmr 与 prompt 入口共用）
```ts
export type DiscoverWorkspacePluginsInput = {
  rootDir: string
  roots: string[]        // 已展开（不包含 "auto"）
  excludeGlobs: string[] // 发现阶段排除明显噪音
}

export type DiscoveredPlugin = {
  name: string
  pkgDir: string
  entry: string          // 必须稳定：绝对路径 or root-relative（二选一）
}

export async function discoverWorkspacePlugins(
  input: DiscoverWorkspacePluginsInput,
): Promise<DiscoveredPlugin[]>
```

### 建议的 doctor-core（可复用扫描结果，避免重复扫描）
为实现“prompt 入口扫描一次即可启动 HMR”的最优路径，建议 `@pluxel/cli` 同时提供一个纯函数的 `doctor-core`：

```ts
export type DiagnoseWorkspaceInput = {
  rootDir: string
  configPath: string
  env?: Record<string, string | undefined>
}

export type WorkspaceSnapshot = {
  activeProfile: string
  roots: string[]                 // 已展开
  enabled: string[]               // 包名
  enabledEntries: string[]        // 入口文件列表（稳定顺序）
  discovered: DiscoveredPlugin[]  // 供 UI/提示复用
}

export type DiagnoseWorkspaceResult =
  | { ok: true; snapshot: WorkspaceSnapshot; warnings: string[] }
  | { ok: false; errors: string[]; discovered?: DiscoveredPlugin[] }

export async function diagnoseWorkspace(
  input: DiagnoseWorkspaceInput,
): Promise<DiagnoseWorkspaceResult>
```

### “借鉴现有 @pluxel/hmr workspace 逻辑”的建议
`@pluxel/hmr` 当前已有若干与 workspace 相关的默认逻辑（例如默认 roots、默认 exclude 等）。建议把这些规则迁移/抽出到 `@pluxel/cli` 的发现模块中（或由 `@pluxel/cli` 再导出一份），从而做到：
- prompt 入口的发现结果与 `@pluxel/hmr` 启动时发现结果完全一致；
- roots `"auto"` 的展开规则只有一处实现；
- 默认 exclude 规则只有一处实现。

## @pluxel/hmr 启动流程（规范）
1. 读取并严格解析配置文件：
   - `pluxel.hmr.jsonc`
   - 缺失或解析失败：报错退出
2. 解析 profile：
   - `activeProfile = process.env.PLUXEL_HMR_PROFILE ?? cfg.profile`
   - 若 `cfg.profiles[activeProfile]` 不存在：报错退出。
3. 合并配置：
   - `roots = profile.roots ?? defaults.roots ?? "auto"` → 展开为实际 roots
   - `enabled = profile.enabled`（必填）
   - `exclude = [...(defaults.exclude ?? []), ...(profile.exclude ?? [])]`
4. 调用 `@pluxel/cli` 的发现 API，得到 `name -> entry` 映射（实时扫描 roots）。
5. 解析 `enabled` 为 entry 列表：
   - 任一包名未发现或 entry 文件不存在：报错退出（提示用户运行 `doctor` 查看可用列表/修复）。
6. 启动 HMR：
   - 实际进入加载/watch/compile 的入口集合 **仅** 为 `enabled` 对应的 entries。
   - `exclude` 按既有语义继续生效（用于手动排除）。

## 最优路径：`pluxel hmr start` 单次扫描启动（避免重复扫描）
默认“直接运行 `@pluxel/hmr`”会执行一次 discovery（读取 package.json）以解析 `enabled`；这是可接受的基线行为。

若你希望**避免重复扫描**（例如 prompt 入口已经扫描过一次），推荐由 `pluxel hmr start` 在同进程内完成：
1. 调用 `@pluxel/cli` 的 `diagnoseWorkspace(...)` 得到 `WorkspaceSnapshot`（扫描 + 校验一次完成）。
2. 将 `snapshot.enabledEntries` 作为启动参数传入 `@pluxel/hmr` 的 start API（见下）。

### @pluxel/hmr start API（建议）
```ts
export type StartFromSnapshotOptions = {
  rootDir?: string
  configPath?: string              // 默认 `${process.cwd()}/pluxel.hmr.jsonc`
  workspaceSnapshot?: WorkspaceSnapshot
}

export async function startHmrFromSnapshot(
  opts: StartFromSnapshotOptions,
): Promise<unknown>
```

行为约束：
- 当 `workspaceSnapshot` 存在时：`@pluxel/hmr` **不得再次 discovery 扫描**，只做最小校验（entry 文件存在、路径可解析等），然后进入正常 HMR pipeline。
- 当 `workspaceSnapshot` 不存在时：`@pluxel/hmr` 按“启动流程（规范）”自己做 discovery。

## `doctor`（唯一标准化能力）
`doctor` 只需要围绕配置文件 + 实时发现给出可执行诊断信息，不规定其余 CLI 形态。

### 必须检查
- 配置文件存在性、JSON 可解析、`version` 正确、无未知字段。
- 所有 profiles 均可合并出有效配置（roots 可展开、enabled 形态正确等）。
- 对当前 active profile：
  - 展开 roots 后的发现结果（可用插件包：name + entry）
  - enabled 中是否存在未发现包名 / entry 不存在

## prompt 入口（推荐使用 @clack/prompts）
你定义的 `pluxel hmr` prompt 入口建议用 `@clack/prompts` 实现交互体验（尤其适合“每次启动前扫描一次”的场景）。

### 推荐组件映射
- 扫描阶段：`spinner`（或 `progress`，若你选择的版本提供该组件）展示“正在扫描 roots / 发现插件包 / 校验 enabled”的阶段进度。
- profile 选择：`autocomplete`（按 profile 名称过滤）或 `select`（profile 少时）。
- 启用集编辑：
  - `autocomplete`（按包名过滤候选）
  - `multiselect`（勾选 enabled 列表；显示已选数量）
- 写入确认：`confirm`（确认写回 `pluxel.hmr.jsonc`）
- 输出信息：`note`/`outro`（总结 active profile、启用数量、roots 展开结果、错误提示）

### 交互原则
- 配置缺失：先创建默认 `pluxel.hmr.jsonc`（最小可用），再进入选择流程。
- 配置解析失败：按“配置文件格式与修复策略”处理（提示 + 备份 `.bak.<timestamp>` + 重新生成）。
- 扫描始终实时：每次进入 prompt 都按 roots 扫一次（只读 package.json），不维护索引产物。
- 启动推荐走 `pluxel hmr start`：prompt 扫描完成后直接把 snapshot 传给 `@pluxel/hmr`，避免重复扫描。
- 写入尽量少：仅当用户变更了 profile/启用集/roots/exclude 才写回文件。

### 生成文件头部注释（建议）
默认生成 `pluxel.hmr.jsonc`，文件开头建议写入类似注释（用于引导，不用于强制）：

```jsonc
// Generated by `pluxel hmr`.
// Prefer using the interactive prompt to edit this file.
// Manual edits are allowed but may be overwritten by the generator.
```
