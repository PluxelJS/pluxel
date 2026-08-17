# CLI 分发与能力发现

> 状态：proposal。本文描述尚未实现的方向，不是当前 CLI 契约。

## 目标

让用户可以：

```sh
pnpm create @pluxel
pnpm add -g @pluxel/cli
pluxel build
```

`pluxel` 成为统一入口，按项目环境组合已经安装的能力；CLI 负责发现与编排，不接管 runtime、构建、HMR
或发行协议的实现。

## 建议方案

### 两个互补入口

- `@pluxel/create`：一次性 initializer，规范入口为 `pnpm create @pluxel`。
- `@pluxel/cli`：长期使用的 `pluxel` 命令，可全局安装，也应固定为项目 `devDependency`。

`@pluxel/create` 只提供 executable，以精确版本依赖 `@pluxel/cli` 并调用唯一的 `pluxel new` 实现。它不复制
模板、prompt 或安装逻辑，也不导出 library API。

这遵循 pnpm/npm 的 scoped initializer 约定：`pnpm create <@scope>` 和 `npm init <@scope>` 解析
`@scope/create`。不再发布语义重复的 `create-pluxel` alias。

参考：[pnpm create](https://pnpm.io/cli/create)、[npm init](https://docs.npmjs.com/cli/v11/commands/npm-init/)。

### 全局入口优先委托项目版本

全局 CLI 只作为 launcher 和 fallback。进入安装了本地 `@pluxel/cli` 的项目后，全局 `pluxel` 应把 argv、
cwd、stdio、signals 和 exit status 原样交给项目本地 executable。

项目内包括 `--help`、`--version` 在内的命令都使用本地版本，避免全局最新版改变老项目行为。CI 和 package
scripts 不依赖 global install，统一使用本地 `pluxel` 或 `pnpm exec pluxel`。

需要诊断全局 launcher 时可提供 `pluxel --global ...`。委托过程不得修改 package.json、lockfile 或自动安装依赖。

### CLI 统一入口，不成为能力所有者

现有边界保持不变：

| Command                                                    | 能力所有者                             |
| ---------------------------------------------------------- | -------------------------------------- |
| `build`, `database`, `distribution`, toolchain `workspace` | `@pluxel/rolldown`                     |
| `hmr`                                                      | `@pluxel/runtime-dynamic/hmr/diagnose` |
| `publish` 的 market webhook                                | `@pluxel/market`                       |
| `new`, `source`, CLI diagnostics                           | `@pluxel/cli`                          |

CLI adapter 只调用 owner 的 public use case，不复制 Plugin lifecycle、build pipeline、HMR discovery 或
distribution protocol。runtime `@pluxel/commands` catalog 也不隐式接入 workspace CLI。

## 能力发现

第一阶段只支持封闭的官方 capability slots。CLI 知道 command 与官方 owner package/subpath 的映射，从当前
package 和 workspace root 的 direct dependencies 解析能力，并在真正执行命令时 lazy import。

因此安装 `@pluxel/runtime-dynamic` 后可以获得 `pluxel hmr`；未安装时 help 只显示 unavailable 和安装提示，
不会加载 runtime-dynamic。

约束：

- 不递归扫描全部 `node_modules` 或 `PATH`；
- transitive、hoisted package 不自动激活能力；
- help/discovery 不 import provider、不访问 registry、不启动 watcher；
- 缺失或版本不兼容时 fail-fast，不自动执行 `pnpm add`；
- capability 未安装时不创建 compiler、watcher、transport 或持久状态。

暂不发布通用 `@pluxel/cli/plugin`、`cli-kit` 或 package manifest extension API。出现至少两个真实的仓库外
provider 后，再单独设计命名冲突、版本协商、错误、取消、cleanup 与信任模型，避免提前固化 gunshi 和当前
command tree。

## 用户路径

创建项目：

```sh
pnpm create @pluxel
```

已安装全局入口的用户也可以继续使用：

```sh
pluxel new --template app-monorepo --name @acme/my-app
```

生成的 app monorepo 与 standalone plugin 都应在 workspace root 固定 `@pluxel/cli`。当前 plugin 模板已经这样
做，app monorepo 模板需要补齐。

日常自动化：

```sh
pnpm exec pluxel build
pnpm exec pluxel database check
```

## 实施顺序

1. 新增 thin `@pluxel/create`，让它复用 `pluxel new`；app monorepo 模板固定本地 CLI。
2. 在完整 CLI 加载前实现 global-to-local delegation，并覆盖 recursion、signal 和 exit propagation。
3. 将 static command map 拆成 CLI core commands 与官方 capability slots，改用 project-anchored resolution。
4. 收集外部 provider 需求，再决定是否开放第三方 extension contract。

## 验收

- `pnpm create @pluxel` 与相同参数的 `pluxel new` 生成相同文件树；
- initializer、CLI 和模板均通过 `npm pack` 后的仓库外 smoke；
- global/local 任意版本组合只执行一次项目本地 CLI，并完整传播 Ctrl-C 和退出状态；
- clean CI 无需 global CLI 即可执行项目命令；
- help 不加载 Rolldown、runtime-dynamic、market、React/Vite；
- direct capability 的安装和移除会确定地改变命令可用性，transitive package 不会误激活。

## 待定

- `@pluxel/create` 与 `@pluxel/cli` 是否需要 Changesets fixed group；
- active package 与 workspace root 安装不同 provider version 时，是 nearest package 胜出还是直接报冲突；
- shell completion 是否需要静态 cache，但它不能形成第二份 command registry。
