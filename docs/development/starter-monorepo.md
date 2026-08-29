---
title: 从 example monorepo 开始
description: 用固定 starter 学习 static/dynamic host、Plugin 依赖、配置、测试和 Web 前端。
---

`@pluxel/create` 发布一个固定、使用中性名称的 example monorepo。它不是按项目名拼接的通用模板；根
`package.json` 没有 `name`，workspace package 固定使用 `@example/*`。先让示例保持可运行，真正形成自己的产品后再
统一重命名。

## 创建和首次验证

```sh
pnpm create @pluxel my-workspace
cd my-workspace
pnpm verify
pnpm dev
```

默认目录是 `pluxel-example`，默认执行 `pnpm install`；只复制文件时使用：

```sh
pnpm create @pluxel my-workspace --no-install
```

create package 不依赖 CLI，也不联网下载模板。它把发布包中的 starter 复制到空目标，并把该版本发布时的完整用户
文档原字节复制到 `docs/pluxel/`。因此新项目在离线环境中也有与 starter 匹配的 API、测试和工具链说明。

## 目录与依赖方向

```text
packages/domain/            @example/domain，纯函数与普通 Vitest
plugins/audit/              @example/audit-plugin，可选 provider
plugins/todo/               config + domain + optional AuditPlugin
plugins/http/               constructor required TodoPlugin + validated HTTP route
host/
  src/pluxel.static.ts      默认与 production runtime authority
  src/pluxel.dynamic.ts     相同 fixed catalog/config + mutable file source
  src/runtime-state.ts      两种 host 共用的 auto-start/config snapshot
  vite.config.ts            指向 web/ 的唯一 Vite config；mode 选择 runtime route
  tsdown.config.ts          staticApplication() + Web public copy
  web/                      @example/web workspace package，React client 与前端专属依赖
pluxel.loader.hmr.jsonc     dynamic loader 的最小 example profile
docs/pluxel/                create 发布时的 Pluxel 文档快照
pncat.config.ts             catalog 分组和迁移的唯一策略入口
```

核心方向是：

```text
one Vite origin
  ├─ / + browser modules -> web
  └─ /api/example/todos  -> HttpPlugin -> TodoPlugin -> domain
                                             |
                                             +-- optional -> AuditPlugin
```

`@example/domain` 不导入 Pluxel；需要 Context、config、依赖图或 lifecycle 的代码留在 Plugin。HTTP 对 Todo 的普通
workspace dependency 对应 constructor required edge。Todo 对 Audit 使用 optional peer dependency、
`peerDependenciesMeta.optional` 和非导出的 module-level `definePluginRef<AuditPlugin>()`，provider 不存在时仍能启动。

## Static 是默认与生产 authority

```sh
pnpm dev
pnpm build
pnpm start
```

`host/src/pluxel.static.ts` 的 default export 同时交给 `staticRuntimeVitePlugin()` 和 `staticApplication()`。fixed catalog、
结构化 auto-start addresses 与 Todo config snapshot 都是显式数据。Workbench artifact 会进入 production distribution，
但启动时默认关闭；需要管理 UI 时使用：

`host/web/` 是独立 private workspace package，直接声明 React 与以后新增的纯前端依赖，但不 import Pluxel。
`host/package.json` 把 `@example/web` 声明为 build-time workspace dependency，并直接声明 Workbench/Vite graph 需要共享的
React singleton、runtime 与三个 Plugin package；两边的 React 版本都来自同一个 catalog，不依赖隐式 hoist。
`staticApplication()` 的 canonical 配置位于 `host/tsdown.config.ts`；根目录只通过 Turbo 编排，不重复 build config。

根目录预装 `pncat`，并用 `pluxel`、`frontend`、`backend`、`test`、`tooling` named catalogs 集中版本政策。
新增、重新分组或清理依赖分别使用 `pnpm catalog:add -- <package>`、`pnpm catalog:migrate` 和
`pnpm catalog:clean`，不要手改 catalog 与 package 引用。集中的是版本选择，不是依赖所有权：每个 workspace
仍声明直接使用的包。Plugin 生产代码通常只需要 `@pluxel/runtime`；测试中的 `@pluxel/test` 及其
`@pluxel/core` peer、Vitest、TypeScript 继续属于各 Plugin 的 `devDependencies`。pnpm 会复用安装内容，重复声明
不会产生多份物理安装。

host build 先用唯一 Vite config 构建 `host/web/dist`，再由 freezer 清理并生成 server/Workbench 产物，同时通过 tsdown
copy 把 Web 输出放入 `host/dist/public`。最后显式执行 `pluxel distribution create`，让最终 inventory 包含浏览器文件；
禁止在 finalization 完成后继续写 distribution。

```sh
PLUXEL_WORKBENCH=true pnpm dev
```

开发时只有 `host/vite.config.ts` 启动一个 `3310` server。它把 Vite `root` 指向 `host/web/`；Pluxel middleware 先认领
generation-scoped Elysia route `/api/example/todos`，其余 browser module、asset 和 navigation 继续交给 Vite SPA。没有 alias、proxy、CORS
或第二套 HMR graph。production 则由 frozen host 从同一 origin 提供 `public/` fallback，调用相同 Plugin routes。

Workbench 启用时使用 `/__pluxel/workbench`，不会与产品 SPA 的 `/` fallback 竞争。

## Dynamic 是 alternative host

```sh
pnpm dev:dynamic
```

`pnpm dev:dynamic` 仍读取同一个 `host/vite.config.ts`，只用 Vite `dynamic` mode 把 static route plugin 替换成 dynamic
route plugin。`host/src/pluxel.dynamic.ts` 复用同一组 fixed plugins、auto-start policy 和 config snapshot，并额外观察：

```text
.pluxel/managed-plugins/*.mjs
```

这展示的是 mutable file source，不包含 package 下载或 market 管理。Static 与 dynamic 使用完全相同的 Plugin class、
constructor dependency、optional ref 和 config authoring model；不要为两条 route 复制业务实现。

## 测试层次

- `packages/domain/tests` 是不启动 Pluxel 的普通 Vitest。
- `plugins/audit/tests` 使用 `@pluxel/test` 的 core-only `withHost()`。
- `plugins/todo/tests` 验证 config、状态操作、optional provider 存在与缺失两种情况。
- `plugins/http/tests` 使用 `withRuntimeHost()` 验证 required edge、HTTP schema、mutation 和错误状态。
- `@pluxel/test/vitest` 对 Plugin source 执行与 build 一致的 semantic lowering 和 lint guard。

选择能覆盖被测 capability 的最小 host；HTTP、Workbench、Vault 等 runtime service 才使用 runtime host。

## 常用命令

```sh
pnpm dev
pnpm dev:dynamic
pnpm build
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm catalog:check
pnpm governance:check
pnpm verify
```

`verify` 是 CI 的 canonical 门禁，覆盖 governance、format、lint，以及 Turbo task graph 中的 typecheck、test 和 build。

## 创建自己的 Plugin package

starter root 安装 `@pluxel/cli` 是为了后续工具命令，不代表 create package 依赖 CLI。在 workspace 中新增一个可独立
发布的 Plugin：

```sh
pnpm exec pluxel new --name @your-scope/your-plugin plugins
```

CLI 只生成 Plugin package；它不会再次生成 starter，也不会复制 `docs/pluxel/`。Plugin package 的发布形状见
[开发和发布插件包](./plugin-package.md)。
