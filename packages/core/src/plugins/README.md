# 插件系统（core/plugins）

这套目录承载 Plugin identity、definition facts、DI graph、generation lifecycle 与作者 composition facade。权威设计见：

- [`../../../../engineering/CORE.md`](../../../../engineering/CORE.md)
- [`../../../../engineering/PLUGIN_SYSTEM.md`](../../../../engineering/PLUGIN_SYSTEM.md)
- [`../../../../engineering/CONFIG.md`](../../../../engineering/CONFIG.md)

## 当前实现基线

- `PluginDefinitionSlot` 唯一识别 canonical entry + root named export；`PluginNodeSlot` 再区分 default/fork node。
- route/storage boundary 使用结构化 entry/definition/node address；Core intern 后只按 slot object 查图。
- `@Plugin` 是薄 marker，只携带 `displayName`、`startTimeoutMs` 和显式 abstract provider relation。
- constructor required dependency 和 `definePluginRef<T>()` optional dependency 都来自 toolchain lowering facts。
- `plugins.use(Ref, callback)` 只允许在 `init()` 中直接调用；callback 同步返回的资源进入 consumer effects。
- `init()` cleanup 与显式 effects 是唯一 generation teardown；没有并行 lifecycle cleanup hook。
- Plugin 最多声明一个 `this.configs.use(ObjectSchema)` class field。

class name、constructor object 和 `displayName` 都不参与 graph identity。没有 lowering facts 的 Plugin 必须明确失败，不允许
reflection 或 name fallback。

## 目录结构

### runtime/

- `identity.ts`：address validation、slot interning 与 formatting；
- `definition.ts`：lowered definition/config/ref facts；
- `PluginService.ts`：registry、graph commit、slot-aware read 与 internal subscriptions；
- `PluginActor.ts`：generation state machine、late init settle；
- `plugin-service/LifecycleManager.ts`：start plan 与 timeout；
- `commit.ts`、`fork.ts`：commit facts 与结构化 fork node。

### decorators/

- `decorators.ts` / `decorator/*`：thin marker validation 与 runtime facts projection；
- decorator 不能恢复 arbitrary metadata bag 或 name identity。

### composition/

- `BasePlugin.ts`：Context、init cleanup adoption 与 generation drain；
- `PluginHost.ts`：init-only optional callback facade；
- `ConfigHost.ts`：single-object config sentinel；
- `symbols.ts`：内部 Context/generation symbols。

Plugin 内部拆分使用普通 class/function。需要子资源 scope 时使用 owner effects；需要独立配置、失败传播、启停、replacement
或治理边界时建模为 Plugin。

## 验证入口

- 黑盒测试集中在 `packages/core/tests/`；
- identity/optional graph 测试覆盖同名 Plugin、required/optional cycle、restart closure 与 provider generation transition；
- lifecycle 测试覆盖 invocation gate、effects drain、rollback、replacement 和 late init cleanup；
- raw runner 只验证缺少 lowering facts时 fail-fast，不能作为正常 Plugin 作者路径。
