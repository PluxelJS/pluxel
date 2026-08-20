---
title: 从纯净 monorepo 开始
description: 用官方起始模板建立静态宿主、Plugin、领域包和 Web 前端。
---

`app-monorepo` 模板适合从零创建完整应用。它把代码分成四个清楚的部分：静态宿主负责装配，Plugin 承载能力和生命周期，领域包保存与框架无关的业务逻辑，Web 提供浏览器入口。模板也会生成相应的 CI 检查。

## 生成和首次验证

```sh
pnpm create @pluxel --template app-monorepo --name @acme/my-app
cd my-app
pnpm install
pnpm verify
pnpm dev
```

模板要求 Node 24+、pnpm 11。根 `engines`、`devEngines.packageManager`、workspace catalog 与 CI frozen install 会阻止错误 package manager 或第二份 lockfile 进入项目。
生成的 workspace root 会固定 `@pluxel/cli`，因此安装完成后本地 `pnpm exec pluxel` 和全局 `pluxel`
都会执行项目版本。已经安装全局入口时，也可以用 `pluxel new --template app-monorepo --name @acme/my-app`
生成同样的结构。

首次修改前运行 `pnpm verify`，确认 Node、pnpm、依赖和生成结果有效。

## 生成后的边界

```text
web/
  src/pluxel.static.ts   canonical static Runtime entry
  src/graphql-entry.ts   browser-facing GraphQL entry
  src/client/            React client 与 fetcher
  vite.config.ts         dev host
  tsdown.config.ts       production static application
plugins/example/
  src/index.ts           Plugin 生命周期、配置与业务 HTTP
  tests/                 Plugin-level tests
packages/domain/
  src/index.ts           不依赖 Pluxel 的领域类型和纯逻辑
  tests/
docs/                    项目本地约束与维护说明
AGENTS.md                coding agent 的 repository rules
```

dependency 方向应保持：

```text
web host -> Plugin -> domain
web client ---------> domain
domain -X-> runtime / Context / Workbench / host config
```

如果 domain 开始 import `@pluxel/runtime`，它就不再是可被 Web、测试和其他执行环境共享的中性包。需要 Context 或 lifecycle 的代码应留在 Plugin。

## 宿主入口

`web/src/pluxel.static.ts` 默认导出 `defineStaticRuntime()`，并由开发 Vite plugin 与生产 `staticApplication()` 共同使用。`plugins` 定义 fixed catalog，`runtimeState.snapshot.enabled` 定义启动时启用的 nodes，`configure()` 返回启动配置。完整配置见 [宿主装配](../getting-started/host-setup.md)。

## 常用命令

```sh
pnpm dev                 # 启动 web workspace 的开发 host
pnpm build               # Turbo 增量构建
pnpm test                # workspace tests
pnpm typecheck
pnpm lint
pnpm format:check
pnpm governance:check
pnpm verify              # CI 的 canonical 聚合门禁
```

`verify` 覆盖 governance、format、lint，以及各 workspace 的 typecheck/test/build。提交前运行 `pnpm verify`；
Turbo 根据输入 hash 决定复用结果，日常脚本不提供绕过缓存的平行入口。

## 首个改动顺序

1. 在 `packages/domain` 定义纯数据与纯函数，并先写测试。
2. 在 `plugins/example` 通过 Plugin Context 接入配置、HTTP、数据库或其他 capability。
3. 把 Plugin 保持在 `plugins` catalog，并用 `pluginNodeAddressOf()` 更新 enabled snapshot。
4. 在 `web/src/client` 添加浏览器 UI，通过明确的 HTTP/GraphQL/Workbench contract 调用能力。
5. 每完成一个边界就运行对应 workspace test，最后运行 `pnpm verify`。

## 何时选择其他起点

- 独立发布、可被多个 host 消费的 Plugin：看 [开发和发布插件包](./plugin-package.md)。
- 已经有成熟 monorepo：不要再嵌套 starter；按 [宿主装配](../getting-started/host-setup.md) 引入 host，并用 [跨仓库源码开发](./source-workspaces.md) 消费本地 Pluxel checkout。
- 运行时发现和替换 package：那是 dynamic host，不应把 package manager 塞进 static starter。
