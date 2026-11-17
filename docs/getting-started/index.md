---
title: 快速开始
description: 使用 @pluxel/create 创建并运行一个包含 HTTP 接口、业务插件与 Workbench 的完整应用。
---

本教程将引导你使用官方脚手架创建并启动一个完整的 Pluxel 项目。示例项目包含一个 Todo 待办服务、对外开放的 HTTP 接口，以及内置的可视化 Workbench 管理界面。

## 创建项目

确保已安装 [Node.js](https://nodejs.org/)（>= 24）和 [pnpm](https://pnpm.io/)（>= 11）。我们推荐配合 [mise](https://mise.jdx.dev/) 管理工具链：

```sh
mise exec node@24 pnpm@11 viteplus@1.3.0 -- vp create @pluxel my-app --no-install
cd my-app
mise trust
mise install
vp install
vp run setup
vp run dev
```

> [!TIP]
> 如果你的环境中没有使用 mise，可直接使用包管理器安装依赖并启动项目：
>
> ```sh
> npx @pluxel/cli new --name my-app
> cd my-app
> pnpm install
> pnpm run dev
> ```

## 访问与体验应用

启动成功后，开发服务器会打印出两个关键地址：

1. **业务前端页面**：在浏览器中打开打印的 Application 地址（默认端口通常为 `3000` 或通过代理的 `8088`）。页面提供了一个交互式 Todo 演示：尝试添加一条待办事项、标记完成或删除。
2. **Workbench 管理工作台**：访问应用地址的 `/__pluxel/workbench` 路径。在这里可以直观查看所有已加载插件的运行状态、依赖拓扑，并在图形化界面中修改配置。

这个轻量待办应用已经走通了完整的插件协作链路：前端页面向 `/api/example/todos` 发起请求，HTTP 服务插件将请求派发给业务 Todo 插件，Todo 插件再通过持久化存储（TinyBase）维护数据状态。

## 进行第一次代码修改

打开项目目录下的 `host/web/src/client/main.tsx`，将页面标题修改为你自己的项目名称：

```tsx
<h1>我的第一个 Pluxel 应用</h1>
```

保存文件后，浏览器将通过 HMR（模块热替换）实时更新界面。

不同关注点的代码分布如下：

- **前端界面与交互**：位于 `host/web/src/client/` 目录。
- **HTTP 路由与接口**：位于 `plugins/http/src/index.ts`。
- **待办业务逻辑与配置 Schema**：位于 `plugins/todo/src/index.ts`。
- **应用装配与插件启停策略**：位于 `host/src/runtime-state.ts`。

## 构建与生产部署

运行完整的代码质量检查（包含类型检查、代码格式化、Lint 与测试）：

```sh
vp run verify
```

执行打包并启动生产模式：

```sh
vp run build
vp run @example/host#start
```

生产打包会静态分析插件清单与依赖拓扑，生成可直接在生产环境部署的轻量运行时产物。

## 下一步

- [编写第一个插件](./first-plugin.md)：从零开发一个拥有独立配置与清理机制的插件包。
- [插件依赖与拓扑](../plugin-development/model.md)：掌握构造函数依赖注入与可选依赖的高级用法。
- [宿主配置教程](../host/configuration.md)：了解如何自定义环境变量、挂载文件存储与组装生产服务。
