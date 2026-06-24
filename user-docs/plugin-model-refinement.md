# Plugin Model Refinement

这份文档只记录下一轮精进 Pluxel 插件模型的三个核心要义。目标是让模型更清晰、更可运维，但不把策略和复杂概念塞进 core。

## 1. Runtime 只负责生命周期语义

Core/runtime 的职责应该保持很小：

- 捕获 `init()` 抛错。
- 标记插件本轮启动失败。
- 阻止依赖失败插件的下游启动。
- 在停止时执行 `stop()` 和 effects cleanup。
- 产出清晰 startup report。

Runtime 不负责：

- 判断某插件是否关键。
- 决定是否退出进程。
- 执行数据库 migration。
- 教插件作者怎么写代码。
- 为“重要错误”改变启动调度顺序。

插件失败是生命周期状态，不是进程控制能力。

## 2. 写法质量靠 lint 和 test helpers

插件最佳实践不应该靠 runtime 热路径兜底。大部分坏写法应该在开发期暴露。

适合 lint 的规则：

- 禁止插件直接 `process.exit(...)`。
- 禁止 constructor 中读取配置值。
- 禁止 class field initializer 中做 I/O 或启动副作用。
- 禁止 `init()` 中裸 `void promise`，除非有 `.catch(...)` 或受控 helper。
- 提醒 timer、watcher、subscription、pool 创建后注册 `ctx.effects.defer(...)`。
- 提醒启动前置条件错误不能只 log 不 throw。

适合 test helper 的场景：

- 配置缺失时插件启动失败。
- DB schema version 不匹配时 provider plugin 启动失败。
- provider 失败时 consumer 不启动。
- optional dependency 缺失时插件仍能启动。
- stop/dispose 后资源释放。

Runtime 保证语义；lint/test 保证插件作者写法质量。

## 3. 错误报告要清晰，不要先做错误策略

比 `fatal`、`requiredPlugins`、resource profile 更重要的是：启动失败不能淹没在日志里。

下一步应优先增强 startup report 的可读性，而不是增加策略：

- 哪个插件失败。
- 失败阶段是什么：config、dependency、start、stop。
- 原始错误信息是什么。
- 哪些插件因此没启动。
- 用户下一步应该看哪里。

目标是让入口、UI、CI、health check 都能基于同一份报告做决策。Core 不需要知道这些决策是什么。

## 保持克制

暂时不要引入：

- 插件声明 `fatal`。
- core 内置 migration runner。
- resource profile registry。
- 人为提前关键插件启动顺序。
- 插件自己表达业务关键性。

先把生命周期语义、lint/test 约束、startup report 做扎实。
