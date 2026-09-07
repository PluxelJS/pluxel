---
title: 快速开始
description: 用 @pluxel/create 创建并启动一个带 React 页面、HTTP API 和 Workbench 的 Pluxel 应用。
---

用 `@pluxel/create` 创建一个可以直接运行的应用。示例包含 React Todo 页面、提供 HTTP API 的插件和管理插件的 Workbench；先跑起来，再按需要了解插件、配置和宿主。

## 创建并启动

准备 **Node.js 24 或更新版本**和 **pnpm 11**，在你存放项目的目录执行：

```sh
pnpm create @pluxel my-app
cd my-app
pnpm dev
```

`pnpm create @pluxel` 调用 `@pluxel/create`，默认安装依赖。目标目录需要不存在或为空；不需要克隆 Pluxel 源码，也不需要全局安装 CLI。

只想先生成文件时，使用 `pnpm create @pluxel my-app --no-install`，随后在生成目录运行 `pnpm install`。

## 确认应用已运行

打开终端打印的 **Application** 地址。页面标题是 **Todo route lab**：输入一条待办并点击 **Add**，再试着勾选完成或删除。

这条操作已经经过完整的应用链路：React 页面请求同一站点的 `/api/example/todos`，HTTP 插件调用 Todo 插件处理状态。

打开终端打印的 **Workbench** 地址，可以查看和管理插件。它位于同一应用地址的 `/__pluxel/workbench` 路径。

示例的待办数据保存在内存中，重启后会重置。需要持久化时再接入[数据库](../runtime/database.md)。

如果本机无法使用默认的命名开发地址，停止当前命令后运行：

```sh
pnpm dev:direct
```

打开这次 Vite 输出的本地地址即可，应用和 API 仍在同一个服务中。

## 做第一处修改

打开 `host/web/src/client/main.tsx`，把页面中的标题改成自己的项目名称：

```tsx
<h1>我的待办应用</h1>
```

保存后查看页面更新。接下来按你要修改的内容选择文件：

| 要修改什么                 | 从哪里开始                     |
| -------------------------- | ------------------------------ |
| 页面与交互                 | `host/web/src/client/main.tsx` |
| HTTP 接口                  | `plugins/http/src/index.ts`    |
| 待办业务逻辑与配置 schema  | `plugins/todo/src/index.ts`    |
| 启动哪些插件、示例初始配置 | `host/src/runtime-state.ts`    |
| 与框架无关的业务规则       | `packages/domain/`             |

生成项目中的包暂时使用 `@example/*` 名称，`my-app` 是你的目录名。可以先围绕示例开发，再统一替换这些包名。

## 验证与构建

在项目根目录运行完整检查：

```sh
pnpm verify
```

它会执行格式、lint、类型检查、测试和构建。只需要构建并启动生产版本时：

```sh
pnpm build
pnpm start
```

示例默认使用 static host：插件清单随应用构建，开发时支持热更新。首次运行无需在不同宿主模式之间做选择；需要运行期间增删插件文件时，再阅读[配置插件宿主](./host-setup.md)。

## 接下来做什么

- **继续开发这个应用**：[示例项目结构与开发流程](../development/starter-monorepo.md)。
- **编写自己的插件**：[编写第一个插件](./first-plugin.md)，再了解[插件依赖与生命周期](./plugin-model.md)。
- **添加一个功能**：[HTTP 接口](../runtime/http.md)、[配置与默认值](./configuration.md)、[Workbench 界面](../workbench/index.md)。
- **让 coding agent 协助开发**：先让它阅读本页和当前任务对应的指南；检查已启动的应用时使用[开发控制台](../development/dev-console.md)。
