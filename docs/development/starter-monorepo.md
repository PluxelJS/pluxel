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

create package 不依赖 CLI，也不联网下载模板。它只把发布包中的 starter 复制到空目标；框架文档保持在
[上游唯一真源](https://github.com/PluxelJS/pluxel/blob/main/docs/index.md)，生成项目可用
`pnpm exec pluxel docs [path]` 打印对应链接。项目自己的 `docs/` 只记录产品契约，不保存需要反复同步的框架快照。

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
结构化 auto-start addresses 与 Todo config snapshot 都是显式数据。Workbench Shell、MF producer inventory 和 manifests 会进入 production distribution，
并默认启用；部署需要 headless 行为时设置 `PLUXEL_WORKBENCH=false`：

`host/web/` 是独立 private workspace package，直接声明 React 与以后新增的纯前端依赖，但不 import Pluxel。
`host/package.json` 把 `@example/web` 声明为 build-time workspace dependency，并直接声明 Workbench/Vite graph 需要共享的
React singleton、runtime 与三个 Plugin package；两边的 React 版本都来自同一个 catalog，不依赖隐式 hoist。
`staticApplication()` 的 canonical 配置位于 `host/tsdown.config.ts`；根目录只通过 Turbo 编排，不重复 build config。

根目录预装 `pncat`，并用 `pluxel`、`frontend`、`backend`、`test`、`tooling` named catalogs 集中版本政策。
新增、重新分组或清理依赖分别使用 `pnpm catalog:add -- <package>`、`pnpm catalog:migrate` 和
`pnpm catalog:clean`，不要手改 catalog 与 package 引用。集中的是版本选择，不是依赖所有权：每个 workspace
仍声明直接使用的包。governance 会拒绝绕过 named catalog 的第三方裸版本，同时保留内部 workspace dependency
和 peer contract。Plugin 生产代码通常只需要 `@pluxel/runtime`；测试 runner `@pluxel/test`、core-only host
`@pluxel/core`、Vitest、TypeScript 继续属于实际使用它们的 Plugin `devDependencies`。`@pluxel/test` 没有 host 根入口；
host 始终从 `@pluxel/core/test` 或 `@pluxel/runtime/test` 导入。pnpm 会复用安装内容，重复声明
不会产生多份物理安装。starter 规则已覆盖常见 React UI、测试、后端/数据和构建工具生态；产品引入新的依赖族时再扩展
`pncat.config.ts`，不要退回按 `dependencies` / `devDependencies` 字段分组。

host build 先用唯一 Vite config 构建 `host/web/dist`，再由 freezer 清理并生成 server/Workbench 产物，同时通过 tsdown
copy 把 Web 输出放入 `host/dist/public`。最后显式执行 `pluxel distribution create`，让最终 inventory 包含浏览器文件；
禁止在 finalization 完成后继续写 distribution。

```sh
PLUXEL_WORKBENCH=false pnpm dev
```

开发时 `pnpm dev` 通过项目本地固定版本的 Portless 提供稳定入口，并由 `host/vite.config.ts` 启动唯一 Vite server：

```text
➜  Application: https://my-workspace.localhost/
➜  Workbench:   https://my-workspace.localhost/__pluxel/workbench
```

实际随机 listener port 是 ingress 实现细节，不是应用契约。`pnpm dev:direct` 可绕过命名入口直接启动 Vite；也可临时使用
`PORTLESS=0 pnpm dev`。Vite 把 `root` 指向 `host/web/`；Pluxel middleware 先认领
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
- `plugins/audit/tests` 使用 `@pluxel/core/test` 的 `createCoreTestHost()` 与立即完成的 `add/remove`。
- `plugins/todo/tests` 使用 Core host 的 `initialConfig`，验证状态操作及 optional provider 存在与缺失两种情况。
- `plugins/http/tests` 使用 `@pluxel/runtime/test` 的 `createRuntimeTestHost()`、`await using` 和 `host.http.fetch()` 验证 required edge、
  HTTP schema、mutation 与错误状态。
- `@pluxel/test/vitest` 对 Plugin source 执行与 build 一致的 semantic lowering 和 lint guard。

选择能覆盖被测 capability 的最小 host；HTTP、Workbench、Vault 等 Runtime service 才使用 Runtime host。常用 command 会立即提交；
多个变化必须共享边界时才使用同步 `commit(change => ...)`。首次配置使用 `initialConfig`，运行期更新使用
`host.config.patch()`。

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

CLI 只生成 Plugin package；它不会再次生成 starter或复制框架文档。Plugin package 的发布形状见
[开发和发布插件包](./plugin-package.md)。
