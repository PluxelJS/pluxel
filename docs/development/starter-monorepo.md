---
title: 把示例项目改成自己的应用
description: 快速开始之后，定位业务代码、添加依赖、切换开发模式并构建应用。
---

完成[快速开始](../getting-started/index.md)后，用本页把 Todo 示例改成自己的应用：找到业务代码、调整配置、增加依赖，再构建可运行的目录。还没有项目时，先完成快速开始的创建和启动步骤。

## 创建和首次验证

以下命令都在生成项目的根目录运行，需要 Node.js 24+ 和 pnpm 11：

```sh
pnpm verify
pnpm dev
```

`verify` 成功后，打开终端打印的 `Application` 地址。创建一条 Todo，再完成或删除它；这些操作经过真实 Plugin HTTP 路由。管理界面使用同一地址下的 `/__pluxel/workbench`。

生成项目暂时保留 `@example/*` 包名，根 `package.json` 没有 `name`。先保持示例可运行，确定自己的业务划分后再一起修改包名、依赖引用和导入。

## 按要修改的功能找文件

| 要做什么                 | 从哪里改                                                 | 如何确认                              |
| ------------------------ | -------------------------------------------------------- | ------------------------------------- |
| 修改 Todo 规则           | `packages/domain/`                                       | 运行该包的普通单元测试                |
| 修改状态、配置或审计集成 | `plugins/todo/src/index.ts`                              | 运行 Todo 插件测试，再通过页面操作    |
| 新增 HTTP 接口           | `plugins/http/src/index.ts`                              | 用 Runtime test host 请求最终路径     |
| 修改产品页面             | `host/web/src/client/`                                   | 打开 Application 地址                 |
| 改启动插件或初始配置     | `host/src/pluxel.static.ts`、`host/src/runtime-state.ts` | 检查启动结果和 Workbench 中的当前状态 |
| 新增独立插件             | [第一个插件](../getting-started/first-plugin.md)         | 接入宿主后验证业务结果                |

框架文档可用 `pnpm exec pluxel docs [path]` 定位；项目自己的 `docs/` 留给业务说明。

## 目录与依赖方向

```text
packages/domain/            @example/domain，纯函数与普通 Vitest
plugins/audit/              @example/audit-plugin，可选 provider
plugins/todo/               config + domain + optional AuditPlugin
plugins/http/               constructor required TodoPlugin + validated HTTP route
host/
  src/pluxel.static.ts      默认与生产入口
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

## 使用默认的 Static 模式开发与部署

默认模式适合插件集合由应用代码决定的产品。

```sh
pnpm dev
pnpm build
pnpm start
```

`pnpm build` 生成 `host/dist/`，`pnpm start` 从 `host/dist/app.mjs` 启动。开发与生产使用同一份 `host/src/pluxel.static.ts`，因此插件列表、启动策略和配置声明不需要维护两份。

构建先生成 `host/web/dist`，再构建服务端并把页面复制到 `host/dist/public`，最后创建包含全部文件的发行清单。扩展构建时，把额外的静态文件写入安排在清单创建之前；详见[发行物](./distribution.md)。

Workbench 默认包含在构建结果中；无需管理界面时可以关闭：

```sh
PLUXEL_WORKBENCH=false pnpm dev
```

### 打开页面与直接运行 Vite

`pnpm dev` 用项目固定的 Portless 提供稳定地址，打开终端打印的 `Application` URL 即可。Workbench 在同一地址的 `/__pluxel/workbench`。不要把内部随机 listener port 保存为应用入口。

需要直接调试 Vite 时用 `pnpm dev:direct`，也可临时设置 `PORTLESS=0 pnpm dev`。Vite root 为 `host/web/`：Todo API `/api/example/todos` 由插件处理，页面、模块和静态文件由同一 Vite 进程提供。生产应用同样从一个 origin 提供 API 与 `public/` 页面。

### 添加依赖

每个 workspace package 声明自己直接使用的依赖。`host/web/` 声明纯前端依赖；`host/` 声明运行时、插件，以及宿主需要共享的 React。两者的 React 版本来自同一 catalog，不依赖隐式 hoist。

根目录的 pncat 集中管理 `pluxel`、`frontend`、`backend`、`test`、`tooling` 分组版本：

```sh
pnpm catalog:add -- <package>
pnpm catalog:migrate
pnpm catalog:clean
pnpm governance:check
```

分别用于添加、重新分组、清理和核对依赖。使用 pncat 更新 catalog 与包引用，不要直接写第三方裸版本；新引入的依赖族在 `pncat.config.ts` 中定义分组规则。内部依赖保留 `workspace:`，peer dependency 保留包自己的兼容契约。

插件生产代码通常只依赖 `@pluxel/runtime`。Vitest、TypeScript、`@pluxel/test` 和使用的测试宿主包属于实际使用它们的包的 `devDependencies`；具体入口见[测试插件](./testing.md)。

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

CLI 会在 `plugins/` 下生成新包。Plugin package 的发布形状见
[开发和发布插件包](./plugin-package.md)。
