---
title: 常见错误与排查
description: 按构建、依赖图、配置、生命周期和宿主边界定位 Pluxel 集成问题。
---

# 常见错误与排查

按 semantic pipeline、graph commit、配置注入和资源 ownership 四个边界定位问题。

## Plugin 看起来是普通 class

**现象：** metadata、依赖、`configs.use()` 或 HMR 行为缺失。

Plugin 源码必须经过 Pluxel 的 Vite/Rolldown pipeline。不要用 raw TypeScript runner 直接执行 Plugin 文件，也不要把 package 的构建命令替换成裸 `tsc`。package 使用 `pluxel build`，测试使用 [测试 harness](../development/testing.md)。

## Plugin 没有启动

依次检查：

1. Plugin 是否进入宿主的 root/plugin plan；
2. required dependency 是否都可解析；
3. graph 是否已经 commit；
4. 配置是否通过 schema 校验；
5. `init()` 是否抛错，或在 signal 取消后仍继续工作。

required dependency 失败会阻止消费者启动。optional provider absent、disabled 或 start-failed 时 callback 不执行，但不会阻止消费者启动。参见 [Plugin 模型](../getting-started/plugin-model.md)。

## 配置值是 `undefined` 或配置校验失败

- `this.configs.use(schema)` 必须是具体 Plugin 的顶层普通 field；
- schema 必须是支持的 object 形状，并且一个具体 Plugin 只声明一次；
- 不要在 constructor 中读取配置；
- 默认值放进 schema，宿主输入仍要经过同一个 schema normalization。

完整规则见 [配置模型](../getting-started/configuration.md)。浏览器表单不是信任边界，提交后服务端仍需校验。

## 停止后端口、timer 或连接仍存在

资源创建成功后立即登记到当前 owner effects，或在 `init()` 返回 cleanup。不要只依赖进程退出和测试框架回收。替换 generation、部分初始化失败和正常 stop 都必须走同一条清理路径。

## HTTP 返回 404

业务路由与 Workbench resource 使用不同边界：

- 业务 API 用 `ctx.http.plugin.routes()`；
- Workbench resource 只有启用 Workbench 且对应 Binding 生效时存在；
- 默认 owner path 与显式 `publicPath` 不同；
- route replacement 后旧 generation 的 handler 不应继续服务。

参见 [插件 HTTP](../runtime/http.md) 与 [管理工作台](../workbench/index.md)。

## 导入路径存在于源码但 package 无法安装

检查 [Package 与入口矩阵](./package-matrix.md)。`private: true` package 仅供 workspace 使用；`internal` 和未列入 `exports` 的路径不是作者入口。

## 诊断信息

诊断记录应包含 Plugin definition/node address、generation、宿主形态、commit summary、结构化错误 code、owner 日志，以及取消或停止状态。debug 日志只针对已经确定的配置、graph、request 或 lifecycle 边界启用。
