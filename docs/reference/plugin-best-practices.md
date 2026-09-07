---
title: 插件提交检查
description: 用 14 项检查确认 Plugin 的边界、生命周期、配置和交付契约。
---

准备提交插件变化时，先运行项目的 `pnpm verify`，再按下面的分组核对本次涉及的行为。只修改普通业务函数时，不必为了满足清单新建插件或宿主。

## 14 项检查

### 拆分与依赖

- [ ] 只有需要独立依赖、配置、失败、启停或治理的单元才是 Plugin；其余逻辑保持为普通对象或函数。
- [ ] Plugin class 从 package root 导出；domain package 不依赖 Runtime、Context、Workbench 或 host policy。
- [ ] Plugin/PluginPart 的 required dependency 使用 package-root value import 和实际 consumer constructor；optional capability 使用 module-level `definePluginRef<T>()`。
- [ ] optional absence、provider failure 与单次请求失败分别处理，不用一个 `undefined` 或 catch-all 混淆。

### 配置与组成

- [ ] 一个 module-level Valibot object schema 是类型、默认值、校验、归一化和表单 metadata 的唯一真源。
- [ ] `this.configs.use(schema)` 是普通 class field；constructor 和 field initializer 不提前读取配置值。
- [ ] 只服务当前 owner、但需要局部 config/effects 的组成使用静态 field-owned `PluginPart`；Part requirement 不在 owner 重复声明，field initializer 不创建资源，副作用留在 `init()`/`plugins.use()` callback；需要独立治理时使用 Plugin。
- [ ] `PluginPart.ctx/host/parts/plugins/configs` 与 `BasePlugin.parts/plugins/configs` 只在对应 subclass 内使用；`BasePlugin.ctx` 保持 public。owner 默认用 private Part field，若公开 Part，只暴露 Part 自己声明的窄业务 API，不增加 root-owner、Context path 或 composition getter。

### 资源与业务边界

- [ ] 资源创建后立即登记 owner-bound、幂等 cleanup；startup 失败、replacement、stop 与 shutdown 都能完整回收。
- [ ] 长请求和后台任务观察 `AbortSignal`，owner 停止后不接受新工作；Plugin 不调用 `process.exit()`。
- [ ] HTTP、command、database、cache、storage 与 secret 都有明确 owner；validation、authorization 和 deployment policy 不混入业务实现。
- [ ] Workbench 只投影 browser-safe contract；关闭 UI 时，核心业务能力仍可运行且不会初始化 UI backend。

### 验证与交付

- [ ] 根据本次行为选择 Core 或 Runtime test host，覆盖相关的配置错误、依赖失败、部分初始化清理、替换和取消；不以普通 `new` 实例替代生命周期测试。
- [ ] package exports、peer dependencies、构建入口和文档一致；`pnpm verify` 通过且没有宽泛规则豁免。

依赖和生命周期契约见 [Plugin 模型](../getting-started/plugin-model.md)，Part composition 见[使用 PluginPart](../getting-started/plugin-parts.md)，配置契约见[配置模型](../getting-started/configuration.md)，验证入口见[测试插件](../development/testing.md)。
