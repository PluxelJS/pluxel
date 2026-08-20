---
title: 插件提交检查
description: 用 12 项检查确认 Plugin 的边界、生命周期、配置和交付契约。
---

本清单用于提交前验证 Plugin 的公共边界和运行时行为。

## 12 项检查

- [ ] 只有需要独立依赖、配置、失败、启停或治理的单元才是 Plugin；其余逻辑保持为普通对象或函数。
- [ ] Plugin class 从 package root 导出；domain package 不依赖 Runtime、Context、Workbench 或 host policy。
- [ ] required dependency 使用 package-root value import 和 constructor 参数；optional capability 使用 module-level `definePluginRef<T>()`。
- [ ] optional absence、provider failure 与单次请求失败分别处理，不用一个 `undefined` 或 catch-all 混淆。
- [ ] 一个 module-level Valibot object schema 是类型、默认值、校验、归一化和表单 metadata 的唯一真源。
- [ ] `this.configs.use(schema)` 是普通 class field；constructor 和 field initializer 不提前读取配置值。
- [ ] 资源创建后立即登记 owner-bound、幂等 cleanup；startup 失败、replacement、stop 与 shutdown 都能完整回收。
- [ ] 长请求和后台任务观察 `AbortSignal`，owner 停止后不接受新工作；Plugin 不调用 `process.exit()`。
- [ ] HTTP、command、database、cache、storage 与 secret 都有明确 owner；validation、authorization 和 deployment policy 不混入业务实现。
- [ ] Workbench 只投影 browser-safe contract；关闭 UI 时，核心业务能力仍可运行且不会初始化 UI backend。
- [ ] 测试通过真实 Runtime host 与 graph commit 覆盖 invalid config、dependency failure、partial-init cleanup、replacement 和 cancellation。
- [ ] package exports、peer dependencies、构建入口和文档一致；`pnpm verify` 通过且没有宽泛规则豁免。

依赖和生命周期契约见 [Plugin 模型](../getting-started/plugin-model.md)，配置契约见 [配置模型](../getting-started/configuration.md)，验证入口见 [测试插件](../development/testing.md)。
