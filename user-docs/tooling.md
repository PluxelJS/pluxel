# CLI 与工具链速查

插件 package 的完整配置、依赖 metadata 和发布流程见
[`plugin-package.md`](plugin-package.md)。本页只列 CLI 命令、配置入口和工具所有权，供开发和 CI
快速查找。

## 安装

`@pluxel/cli` 按命令延迟加载能力，不是 runtime 或 build API 的聚合包：

```sh
# 脚手架和命令入口
pnpm add -D @pluxel/cli

# plugin package build
pnpm add -D @pluxel/rolldown tsdown oxlint

# 有 Workbench UI declaration 时
pnpm add -D vite

# dynamic loader HMR profile/diagnostics
pnpm add -D @pluxel/runtime-dynamic
```

缺少可选工具只会禁用对应命令，不影响根帮助和脚手架。

## 常用命令

| 命令                                                      | 用途                                                |
| --------------------------------------------------------- | --------------------------------------------------- |
| `pluxel new --template plugin --name @scope/orders`       | 创建 `@scope/pluxel-plugin-orders` 插件 package     |
| `pluxel new --template app-monorepo --name @scope/my-app` | 创建同名、不会添加插件前缀的应用 monorepo           |
| `pluxel build`                                            | 用标准 plugin-package preset 构建当前目录           |
| `pluxel build --watch`                                    | watch 模式；每轮成功构建重新同步 metadata           |
| `pluxel build --debug`                                    | 输出最终合并的 tsdown 配置、plugin 顺序和 hook 状态 |
| `pluxel database generate --name <name>`                  | 生成 PostgreSQL migration 与 checksum manifest      |
| `pluxel database check`                                   | 检查 migration history、rewrite 和 schema drift     |
| `pluxel database rebase --lineage <id>`                   | 生成全新 lineage baseline，部署后保留旧 instance    |
| `pluxel hmr doctor`                                       | 诊断 dynamic loader workspace/profile               |
| `pluxel hmr enabled`                                      | 编辑 dynamic profile 的 enabled plugin 集合         |
| `pluxel hmr builtin`                                      | 编辑 dynamic profile 的 builtin plugin 集合         |
| `pluxel publish --dry-run`                                | 预演 npm publish 和 market 通知流程                 |

在 package script 后传参时保留 `--`：

```sh
pnpm build -- --debug
pnpm build -- --watch
```

## `pluxel build` 读取什么

命令以当前工作目录为 package root，并按顺序完成：

1. 定位当前 package 的 `package.json`；
2. 读取插件命名前缀和 manifest 字段；
3. 查找第一个存在的 `tsdown.config.*`；
4. 把用户 tsdown config 与标准 `pluginPackage()` preset 合并；
5. 运行 tsdown/Rolldown；
6. 成功后事务性同步 plugin peer 和 `pluginPackages` metadata；
7. 最后执行用户 `onSuccess`。

默认配置文件发现顺序是 `.ts`、`.mts`、`.cts`、`.js`、`.mjs`、`.cjs`、`.json`。一个 package
只导出单个 config object 或返回单个 object 的 async function；CLI 不接受 config array，因为 plugin package
只有一个明确的输出计划。

构建失败不会提交部分 metadata。相同输入连续构建是幂等的；ESM/CJS 多格式输出共享同一份 semantic
facts。

## 构建环境变量

| 环境变量                | 默认值          | 用途                                       |
| ----------------------- | --------------- | ------------------------------------------ |
| `PLUXEL_PLUGIN_PREFIX`  | `pluxel-plugin` | 逗号分隔的插件 package 名称前缀            |
| `PLUXEL_MANIFEST_FIELD` | `pluxel`        | `pluginPackages` 所在的顶层 package 字段   |
| `PLUXEL_TSDOWN_CONFIG`  | 自动发现        | 显式指定相对 package root 的 tsdown config |

CI 与本地必须使用相同的 prefix/manifest 配置，否则同一源码会生成不同 package metadata。常见组织级
配置：

```sh
PLUXEL_PLUGIN_PREFIX=pluxel-plugin,acme-plugin pnpm build
```

## API 从所有者 package 导入

代码不要从 `@pluxel/cli` 导入 API：

```ts
import { resolveBuildContext } from '@pluxel/rolldown/build'
import { diagnoseLoaderHmrWorkspace } from '@pluxel/runtime-dynamic/hmr/diagnose'
```

| 能力                                             | 所有者入口                             |
| ------------------------------------------------ | -------------------------------------- |
| plugin package / static application build preset | `@pluxel/rolldown/build`               |
| Vite source adapter                              | `@pluxel/rolldown/vite`                |
| Pluxel Oxlint rules                              | `@pluxel/rolldown/oxlint`              |
| dynamic loader diagnostics                       | `@pluxel/runtime-dynamic/hmr/diagnose` |
| test preset                                      | `@pluxel/test/vitest`                  |

普通插件作者只需要 `pluxel build`，不需要在 `tsdown.config.ts` 直接调用 build preset。直接导入
`@pluxel/rolldown/build` 主要用于宿主的 `staticApplication()` 配置或构建工具集成。

`hmr/diagnose` 只读取和修改 profile、workspace discovery 与 snapshot，不注册 dynamic runtime services。

数据库命令以当前 package 为 root，默认自动寻找唯一 `defineDatabase()` module 和 `drizzle/`。定义不唯一时用
`--schema` 明确指定。默认 `migrations` 策略必须一起提交 SQL、Drizzle meta 与 `pluxel-migrations.json`，CI 在 build 前运行
`pluxel database check`；普通变更只追加 migration，明确放弃旧 history 时才执行 `database rebase`。显式
`reset-on-schema-change` 不运行这些命令也不提交 `drizzle/`，`pluxel build` 自动生成当前 baseline 和 schema-derived lineage。
详细作者流程见 [`database.md`](database.md)。

## Plugin package 与 static application 不要混用

| 构建对象           | 标准入口              | optional provider 策略                | 输出目的                   |
| ------------------ | --------------------- | ------------------------------------- | -------------------------- |
| 独立插件 package   | `pluxel build`        | external optional peer                | 发布给多个宿主复用         |
| static application | `staticApplication()` | present bundle / missing absent chunk | 固定、可部署的完整应用闭包 |

插件 package 不把 Pluxel runtime 或 provider plugin 打入自身 bundle。static application 则冻结所有可解析
provider；部署目标上后来安装 package 不会改变闭包。完整 package 配置见
[`plugin-package.md`](plugin-package.md)，宿主构建见 [`host-setup.md`](host-setup.md)。

## Workbench UI 构建缓存

`pluxel build` 从 server-only `workbench.extension()` 提取 literal
`workbench.entry(import.meta.url, './ui/index.tsx')`。无 UI declaration 时不会加载 Vite/Federation；有 UI
时 server bundle 与 `dist/workbench/<artifact>/` remote 分开生成。

完整 remote 缓存在 `.pluxel/workbench-build/<artifact>/<hash>/`。缓存 key 包含 source graph、lockfile、
shared versions 和 compiler/build-contract version；可以安全删除该目录做冷构建。static application 还会校验
Workbench shell 与 runtime 的 contract protocol；若提示 shell protocol 不一致，应先重新构建当前
`@pluxel/runtime`，不能继续发布混合产物。构建并发、shared contract、缓存保留和 staging 目录全部由
Pluxel 管理；remote builder 也不合并宿主 Vite 配置，项目不需要为 Federation 增加调优配置。

## Node module artifact

`pluxel build` 同样提取 module-level `defineNodeModule(import.meta.url, './entry.ts')`，把 server declaration lowering
到 stable artifact key，并输出 `dist/artifacts/node/<artifact-key>.mjs`。缓存位于
`.pluxel/plugin-artifacts/node/<artifact-key>/<source-hash>.mjs`；插件 package 与 static application 使用同一提取和构建
管线。headless/workbench static variant 都包含可达 Node artifacts。

Node branch 和 Workbench UI branch 共享 source/build cache lifecycle，但目标 graph、validator 与输出配置隔离；
Workbench disabled 不会加载 Federation builder，只使用 Node module 也不会创建 UI backend。
