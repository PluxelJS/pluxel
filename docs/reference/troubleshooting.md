---
title: 常见错误与排查
description: 按构建、依赖图、配置、生命周期和宿主边界定位 Pluxel 集成问题。
---

本页汇总了在开发、编译与运行 Pluxel 应用时常见的报错及排查方案。

## 快速问题定位

| 错误或异常现象 | 优先排查方向 |
| :--- | :--- |
| 安装新版本依赖报 `ERR_PNPM_NO_MATURE_MATCHING_VERSION` | [检查发布等待时间策略](#刚发布的版本安装时报-err_pnpm_no_mature_matching_version) |
| 无法解析子路径导入（如 `Failed to resolve import`） | [检查 package.json 导出声明与构建产物](#构建无法解析包或-subpath) |
| TypeScript 报错 `TS2574`（关于 Rest 元素需为数组） | [查看 Cap'n Web 类型兼容性说明](#capn-web-声明报-ts2574) |
| 插件未生效或类行为表现异常 | [确认是否经过了 Pluxel 编译器转换](#plugin-看起来是普通-class) |
| 插件处于期望运行状态但未实际启动 | [检查生命周期错误日志与依赖关系](#plugin-没有启动) |
| 插件停止后后台端口、Timer 或连接仍存活 | [检查生命周期清理逻辑（Effects 与 dispose）](#停止后端口timer-或连接仍存在) |
| 插件中定义的 HTTP 路由返回 404 | [排查路由挂载时机与载体上下文](#http-返回-404) |

## 刚发布的版本安装时报 `ERR_PNPM_NO_MATURE_MATCHING_VERSION`

这表明当前工程或全局 pnpm 配置了供应链安全防范策略 `minimumReleaseAge`（默认通常为 24 小时）。
- **原因**：目标 npm 包版本的发布时间尚短，处于防御锁定期内。
- **解决方案**：
  1. 等待该版本发布满设定时长（如 1440 分钟）后重新执行安装；
  2. 若为紧急上线，可在 `pnpm-workspace.yaml` 中为该特定包配置 `minimumReleaseAgeExclude` 白名单放行。

## 构建无法解析包或 subpath

例如报错：`Failed to resolve import "valibot-form/web"`：
1. **依赖直属声明**：确认报错模块所在的子包在自己的 `package.json` 中直接声明了该依赖，不要依赖 Monorepo 根目录的隐式提升（Hoist）。
2. **确认 Exports 导出**：检查目标依赖包的 `package.json` 中的 `exports` 字段，确认是否声明了对应的子路径导出（如 `"./web"`）。
3. **工作区依赖构建顺序**：如果引用的是本地 Monorepo 子包，确认在当前构建执行前，依赖包已经完成了编译并生成了产物。

<span id="capn-web-声明报-ts2574"></span>
## Cap’n Web 声明报 `TS2574`

在开启严格类型检查（`skipLibCheck: false`）的 TypeScript 6/7 环境中，`capnweb@0.12.0` 的某些泛型解包可能触发：
`A rest element type must be an array type (TS2574)`。
- **说明**：这是上游类型声明的问题，并不影响运行时 RPC 的正常执行。
- **处理建议**：在工程的 `tsconfig.json` 中设置 `"skipLibCheck": true`，或者在依赖补丁中对该声明打上类型修补。

## Plugin 看起来是普通 class

**现象**：定义的 `@Plugin()` 装饰器、`configs.use()` 配置注入或依赖注入无法正常工作。
- **原因**：Plugin 源码未经过 Pluxel 的专用编译插件（`@pluxel/rolldown` 或 `@pluxel/host-vite`）进行语义降阶。
- **解决方案**：
  - 构建插件时请使用 `pluxel build`，避免使用裸 `tsc` 编译；
  - 运行单元测试时使用 `@pluxel/test` 提供的专用宿主容器；
  - 在 Vite 中开发时，确保宿主工程配置了 `@pluxel/host-vite` 插件。

## Plugin 没有启动

**排查步骤**：
1. **检查控制台日志**：在实时日志中搜索 `Plugin lifecycle operation failed`，查看具体的异常堆栈。
2. **检查必需依赖（Required Dependencies）**：若当前插件依赖了外部服务或插件，确认该依赖已被装配且成功启动。前置依赖启动失败会自动阻塞后续依赖节点的初始化。
3. **检查配置校验**：确认宿主传入的初始配置符合当前插件声明的 Schema 结构。
4. **检查 `init()` 方法**：确认初始化生命周期逻辑中是否存在未捕获的 Promise Rejection 或死循环。

## PluginPart constructor dependency 无法解析

- `PluginPart` 必须通过宿主插件的 `this.parts.use(PartClass)` 进行静态挂载；
- Part 构造函数中注入的插件类型，必须从对应的公开包根路径进行 `value-import`。

## 停止后端口、Timer 或连接仍存在

在插件销毁或重载时遗留资源：
- **解决方案**：在插件或 Part 中创建的长连接、定时器（`setInterval`）或后台工作任务，应使用 `this.ctx.effects.defer(() => clearInterval(id))` 进行登记，或者在 `init()` 返回清理回调函数。

## HTTP 返回 404

1. **路由声明时机**：插件的路由必须在构造函数或 `init()` 生命周期阶段声明在 `this.ctx.require(ElysiaApp)` 上。在服务完成初始化并开始对外监听后动态追加的路由将无法被生效识别。
2. **路由路径**：Elysia 中声明的路径即为最终请求路径，框架不会自动拼接插件名作为前缀。
3. **保留路径冲突**：`/__pluxel` 为系统控制台与管理端点预留命名空间，业务路由请勿以此为前缀。
