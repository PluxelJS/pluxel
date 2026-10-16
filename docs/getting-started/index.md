---
title: 快速开始
description: 用 @pluxel/create 创建并启动一个带 React 页面、HTTP API 和 Workbench 的 Pluxel 应用。
---

用 `@pluxel/create` 创建一个可以直接运行的应用。示例包含 React Todo 页面、提供 HTTP API 的插件和管理插件的 Workbench；先跑起来，再按需要了解插件、配置和宿主。

## 创建并启动

先按 [mise 入门](https://mise.jdx.dev/getting-started.html)安装并激活 mise。使用 Node.js 24、pnpm 11 和 Vite+ 创建项目，进入生成目录后安装项目固定的工具链：

```sh
mise exec node@24 pnpm@11 viteplus@1.2.0 -- vp create @pluxel my-app --no-install
cd my-app
mise trust
mise install
vp install
vp run setup
vp run dev
```

`vp create @pluxel` 调用 `@pluxel/create`。这里用 `--no-install` 先生成文件，再由 `vp install` 安装依赖、`vp run setup` 准备 Pluxel 工作区。目标目录需要不存在或为空；不需要克隆 Pluxel 源码或全局安装 CLI。

项目初始化 Git 后运行 `vp run hooks:install` 安装 hk 提交检查。工具职责、常用命令和代理设置见[工作区工具链](../development/workspace-toolchain.md)。

## 确认应用已运行

`vp run dev` 通过 Pitchfork 启动 `app` 服务，命令结束后服务继续运行。用 `pitchfork logs app` 查看 Vite 打印的 **Application** 地址并打开。页面标题是 **Todo route lab**：输入一条待办并点击 **Add**，再试着勾选完成或删除。

这条操作已经经过完整的应用链路：React 页面请求同一站点的 `/api/example/todos`，HTTP 插件调用 Todo 插件处理状态。

打开同一日志中打印的 **Workbench** 地址，可以查看和管理插件。它位于同一应用地址的 `/__pluxel/workbench` 路径。

示例的待办数据保存在内存中，重启后会重置。需要持久化时再接入[数据库](../plugin-development/database.md)。

项目默认启用固定 `8088` 端口的 HTTP 代理，无需项目外配置。已有 supervisor 的迁移和代理诊断见[工作区指南](../development/workspace-toolchain.md#端口与公开地址)。需要直接调试 Vite 时运行：

```sh
pitchfork stop app
vp run @example/host#dev:server
```

打开这次 Vite 输出的本地地址即可，应用和 API 仍在同一个服务中。结束托管开发会话时使用 `pitchfork stop app`。

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
vp run verify
```

它会执行格式、lint、类型检查、测试和构建。只需要构建并启动生产版本时：

```sh
vp run build
vp run @example/host#start
```

示例使用同一个应用声明描述固定插件与可选动态来源，开发时支持热更新。配置来源与启动策略见[配置插件宿主](../host/configuration.md)。

## 接下来做什么

- **继续开发这个应用**：[示例项目结构与开发流程](../development/starter-monorepo.md)。
- **编写自己的插件**：[编写第一个插件](./first-plugin.md)，再了解[插件依赖与生命周期](../plugin-development/model.md)。
- **添加一个功能**：[HTTP 接口](../plugin-development/http.md)、[配置与默认值](../plugin-development/configuration.md)、[Workbench 界面](../workbench/index.md)。
- **定位并修改已有功能，或让 coding agent 协助开发**：从[开发工作流程](../development/index.md)选择 inspect、devconsole 和测试，再读任务对应的功能指南。
