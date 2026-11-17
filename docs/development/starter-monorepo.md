---
title: 把示例项目改成自己的应用
description: 快速开始之后，定位业务代码、添加依赖、配置动态来源并构建应用。
---

完成 [快速开始](../getting-started/index.md) 后，可以通过本指南将生成的 Todo 示例脚手架改造为自己的实际业务系统：熟悉目录职责、调整配置与插件装配、添加第三方依赖并完成生产构建。

## 启动与初始化验证

在脚手架工程根目录下执行：

```sh
vp run verify
vp run dev
```

启动完成后，通过 `pitchfork logs app` 查看本地访问地址并在浏览器中打开。应用前端访问根路径，管理控制台访问 `/__pluxel/workbench`。

## 代码目录与功能映射

按业务需求查找对应的修改入口：

| 需求场景                       | 修改目标路径                                              | 验证与调试方式                               |
| :----------------------------- | :-------------------------------------------------------- | :------------------------------------------- |
| 调整核心领域实体与业务逻辑     | `packages/domain/`                                        | 运行该子包的 Vitest 单元测试                 |
| 调整业务插件的状态、配置或审计 | `plugins/todo/src/index.ts`                               | 运行插件集成测试，并在前端界面中操作验证     |
| 增删或修改 HTTP API 接口       | `plugins/http/src/index.ts`                               | 编写基于 `createTestHost()` 的 HTTP 接口测试 |
| 修改前端界面与交互             | `host/web/src/client/`                                    | 在浏览器中直接查看热更新后的界面             |
| 调整自启插件与应用初始配置     | `host/src/app.ts` 与 `host/src/runtime-state.ts`          | 检查应用启动日志并在控制台确认生效状态       |
| 新增独立的业务插件             | 参考 [编写第一个插件](../getting-started/first-plugin.md) | 装配到宿主清单中进行验证                     |

## 工程目录结构

```text
packages/domain/            @example/domain：纯业务领域逻辑，无框架依赖
plugins/audit/              @example/audit-plugin：可选的审计日志插件
plugins/todo/               Todo 核心业务插件（管理状态与配置，可选依赖审计）
plugins/http/               Todo HTTP API 路由插件（注入 TodoPlugin 并暴露接口）
host/
  src/app.ts                开发与生产共用的宿主装配文件（声明插件列表与数据来源）
  src/runtime-state.ts      插件自启策略与初始配置快照
  vite.config.ts            前端 Vite 开发配置
  tsdown.config.ts          生产构建打包配置
  web/                      前端 React 应用工程与 UI 组件
mise.toml                   工具链版本管理
vite.config.ts              全仓 Vite Task 任务拓扑与 Lint/Fmt 规范
pitchfork.toml              后台服务托管配置
pncat.config.ts             依赖版本分组管理策略
```

整个系统的调用流向遵循单向清晰的分层：
前端客户端请求单一 Origin，API 路由分发给 `HttpPlugin`，再调用 `TodoPlugin` 执行具体领域动作。

## 开发与生产部署

宿主定义 `defineHostApplication` 同时适用于本地开发与生产运行：

```sh
# 启动本地开发服务
vp run dev

# 执行全仓构建
vp run build

# 启动生产构建产物
vp run @example/host#start
```

构建流程会依次打包前端静态资源、编译服务端模块并将静态页面输出至 `host/dist/public`。

<span id="添加依赖"></span>

## 添加与管理依赖

Monorepo 中的各个包应各自显式声明直接使用的依赖：

- `host/web/` 维护纯前端依赖（React、组件库等）；
- `host/` 维护服务端运行时与插件宿主依赖；
- 插件包将核心运行时（如 `@pluxel/core`）声明为 `peerDependencies`，实现依赖放入 `dependencies`，测试辅助包放入 `devDependencies`。

使用内建的 pncat 工具维护依赖版本一致性：

```sh
# 添加依赖到 catalog
vp exec pluxel pncat add <package>

# 迁移旧依赖并清理
vp exec pluxel pncat migrate
vp exec pluxel workspace sync
vp exec pluxel pncat clean

# 检查工作区依赖治理规范
vp run governance:check
```

## 测试分层

工程提供了不同层次的测试方案：

- **纯逻辑测试**：在 `packages/domain/tests` 中使用纯 Vitest 进行无框架的快速测试。
- **插件行为测试**：使用 `@pluxel/test` 提供的 `createTestHost()` 启动内存宿主，验证依赖装配、生命周期回调与配置更新。
- **接口测试**：为测试宿主安装 HTTP 服务，直接通过 `host.http.fetch()` 发起内存请求断言响应。

## 新增可发布的独立插件包

在工作区中直接生成符合规范的新插件模板：

```sh
vp exec pluxel new --name @your-scope/your-plugin plugins
```

CLI 会在 `plugins/` 目录下自动生成包含标准清单、TypeScript 配置与测试设施的新插件骨架。
