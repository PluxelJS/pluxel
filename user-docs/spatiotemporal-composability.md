---
title: 从时空可组合性看 Pluxel
description: 以 Cordis 论文的 effect、coeffect 与动态组成模型为坐标，说明 Pluxel 的对应机制、不同实现和边界。
---

# 从时空可组合性看 Pluxel

[Cordis 论文](https://github.com/cordiverse/paper)讨论的不是某个 Plugin API 应该长什么样，而是一个更基础的问题：组件如何在共享环境中反复加入、退出和重新组合，同时不留下已经失去所有者的状态，也不继续使用已经失效的依赖。

这套问题意识同样存在于 Pluxel。不过，Pluxel 不是 Cordis 形式模型的另一份实现。两者追求的运行结果有很大交集，却把信息和复杂度放在了不同阶段：Cordis 用统一的 Context/Fiber runtime 解释 effect 与 coeffect；Pluxel 将业务依赖尽量提前为构建期 graph fact，再用 generation effects 管理运行时资源。

因此，下面的比较不寻找同名 API，而逐项判断论文中的机制在 Pluxel 是直接体现、由不同机制实现、有意不采用，还是仍有缺口。

## 论文提出的两个组成维度

论文把动态组成分为两个互相独立、又必须共同成立的维度：

- **Temporal composability（时间可组合性）**：组件退出时，应完整、安全地撤销自己对共享环境的修改。
- **Spatial composability（空间可组合性）**：组件声明自己需要什么；环境变化时，系统重新判断依赖是否满足，并驱动组件进入或退出 active 状态。

论文用 **revertible effect** 表达前者：一次对 Context 的变换带有逆操作，多个逆操作按 LIFO 顺序组合。它用 **reactive coeffect** 表达后者：组件对环境提出依赖条件，Context 变化被分类为 activating、deactivating 或 neutral，再触发相应的 Fiber transition。

Cordis 最重要的设计判断，是 effect context 与 coeffect context 可以统一成一个 Context。组件对环境的写入、从环境的读取、依赖满足状态、隔离和拦截，因而都能由同一套 runtime protocol 解释。

Pluxel 接受“时间与空间都必须可组合”这个问题定义，但没有接受“它们必须进入同一个运行时表”这个实现前提。

## 总览

| 论文机制                              | Pluxel 中的对应                                     | 关系                   |
| ------------------------------------- | --------------------------------------------------- | ---------------------- |
| Revertible effects                    | generation-owned `EffectsService`                   | 相同目标，工程化实现   |
| Reactive coeffects                    | lowered Plugin graph + graph commit/restart         | 相同目标，不同实现     |
| Unified Context                       | Plugin graph、effects、host Context 分层            | 有意不采用统一模型     |
| Component / Fiber                     | Plugin definition/node 与 runtime generation        | 近似对应，并非同构     |
| Isolation                             | plugin-owned Context、node/fork identity            | 局部体现，范围更窄     |
| Interception                          | caller-bound view、owner-bound handle 与领域 policy | 局部体现，不是通用机制 |
| Provider withdrawal                   | consumer-first stop、generation-bound handle        | 直接体现运行结果       |
| Async transition                      | abort、invocation gate、late-init guard             | 相同问题，不同状态机   |
| Declarative loader / HMR              | static/dynamic catalog、Vite graph、replacement     | 相同目标，事务边界不同 |
| Observational equivalence、confluence | 没有形式化证明                                      | 尚不能声称             |

## 时间可组合性：资源属于 generation

Pluxel 中最直接对应 revertible effect 的机制，是每个 Plugin generation 拥有自己的 effects。`effects.defer()`、`own()`、`acquire()`、`scope()` 和 `transaction()` 将 cleanup 绑定到当前 owner；`init()` 返回的 cleanup 或 disposable 也会自动进入同一作用域。

```ts
override async init(signal: AbortSignal) {
	const client = createClient(this.config)
	this.ctx.effects.defer(() => client.close(), { tag: 'client' })

	await client.connect({ signal })
}
```

正常 stop、replacement、启动回滚、optional restart 和 root shutdown 不各自发明 teardown 路径，而是结束 generation 并 drain 同一组 effects。资源一旦成功创建，就应立即登记 cleanup；这样即使后续初始化失败，也不会等到函数末尾才发现没有拿到 disposer。

这里与论文的数学 effect 仍有边界差异：Pluxel 会在生命周期结束时尝试所有已登记的 cleanup，以幂等方式消费 cleanup ownership，并聚合清理错误；它不能验证 cleanup 真的是原操作的逆，也不能证明执行前后的环境 observationally equivalent。作者绕过 effects 直接修改全局状态时，runtime 也无法自动恢复它。

因此，更准确的说法是：Pluxel 将论文的时间可组合性落实为一个明确的资源所有权协议，而不是实现了可逆性的形式证明。具体使用方式见 [Plugin 模型与生命周期](./getting-started/plugin-model.md#generation-是资源所有权边界)。

## 空间可组合性：依赖变化仍会驱动生命周期

Pluxel 也有 reactive coeffect 所关心的行为。required provider 必须先于 consumer 启动；provider 失败会阻塞 required dependents。optional provider 的 running generation 出现、消失或被替换时，Core 会重启 consumer 及其 required dependent closure，让 callback 取得当前 generation，而不是继续持有旧实例。

差别在于依赖条件从哪里来、何时被解释。

Cordis 的 Fiber 在 runtime 声明和观察 Context dependency。`provide()`、isolate 或上层 Context 的变化可以使 coeffect 从 satisfied 变为 unsatisfied，runtime 随即重新推进 Fiber。

Pluxel 的业务依赖则在 TypeScript 被擦除前完成 lowering：

```text
constructor value import / optional Plugin ref
  -> semantic facts
  -> required/optional graph edge
  -> graph verification
  -> commit 中的 stop/start plan
```

required edge 来自 package-root value import 与 constructor 参数；optional edge 来自 type-only provenance、`definePluginRef<T>()` 和直接的 `plugins.use()`。Runtime 只消费已经 lower 的 definition slot 与 edge，不再从任意 Context property access 推断业务依赖。

所以 Pluxel 的 graph 也是 reactive 的，但反应边界更显式：catalog、配置或 dependency override 先形成 draft，`commit()` 验证并应用新 graph。任意代码不能通过一次 `ctx.set()` 在未提交 graph 的情况下改变业务组成。这是对 reactive coeffect 的不同 realization，而不是缺少动态装载。参见 [Plugin 模型与生命周期](./getting-started/plugin-model.md)和 [测试应用与 Plugin](./development/testing.md#core-lifecycle)。

## 为什么没有把一切统一进 Context

Pluxel 把 Cordis 统一 Context 承担的职责拆到四个边界：

| 信息                                  | Pluxel 的承载位置                                 |
| ------------------------------------- | ------------------------------------------------- |
| 业务 Plugin 依赖                      | 构建期生成、commit 时验证的 Plugin graph          |
| Plugin 对资源的修改                   | generation-owned effects                          |
| HTTP、logger、database 等宿主基础设施 | 每个 Plugin 的稳定 Context service                |
| 需要调用者语义的动态访问              | 局部 caller-bound Proxy view 或 capability handle |

这样做牺牲了统一 Context 的通用性。Pluxel 不能让任意 key 在 runtime 成为新的 reactive dependency，也没有一套对所有 capability 通用的 realm 和 metadata interception API。

换来的约束是：业务依赖身份来自 canonical package entry 与 root named export，依赖使用位置就是 constructor 或 optional integration 本身；缺失依赖、循环和不合法 provenance 在应用 graph 提交前已有明确事实。Proxy 可以改变一次调用看到的 caller view，却不能暗中改变 graph identity 或 lifecycle ordering。

这也是两者真正的架构分岔：Cordis 把开放世界中的 late binding 交给 Context/Fiber runtime；Pluxel 把可静态获知的业务组成前移到 semantic pipeline，只为宿主能力和调用适配保留动态性。

## Component、Fiber 与 generation

Cordis 论文中的 component 描述可装载的程序，Fiber 则持有一次执行、它产生的 effects、依赖状态和 transition。Pluxel 中大致可以用下面的关系帮助理解：

```text
Cordis component  ~  Pluxel Plugin definition/node
Cordis Fiber      ~  Pluxel runtime generation
```

这个对应并不严格。Pluxel 将稳定 identity、配置后的 runtime node 与每次启动产生的 generation 分开；同一个 node replacement 后仍是同一组成位置，但旧 generation 的实例、handles 和 effects 都必须失效。Fiber 的 Context hierarchy、realm 和 coeffect transition 也没有一一对应到 Pluxel generation。

## Provider withdrawal、异步与失败

论文特别讨论 provider withdrawal：consumer teardown 期间仍可能需要旧 dependency 完成清理，因此不能先让 provider 消失，再要求 consumer 自行收尾。

Pluxel 通过 graph ordering 表达相同约束：provider-first start、consumer-first stop；optional provider 变化时，consumer effects 也必须在 provider 停止前 drain。领域 capability 还会把 handle 同时绑定 consumer owner 与 provider generation，任一方停止后拒绝新调用。

异步 transition 的处理方式不同于论文的抽象机，但面对的是同一类竞态：

- generation 停止时先关闭 owner invocation gate，拒绝新调用；
- abort 已接纳调用的 lifecycle signal，并等待 invocation lease 释放；
- 随后 drain generation effects；
- 已失效的 `init()` 即使稍后 resolve，也不能重新发布 running；它迟到返回的 cleanup 会立即执行。

这保证 Pluxel 自己接纳的调用和资源不会无所有者地跨过 replacement。它不意味着所有 JavaScript Promise 都会被 runtime 接管：脱离 owner signal、invocation gate 和 effects 的后台任务，仍然是 Plugin 作者必须修正的生命周期逃逸。

失败传播也不是全局回滚事务。一次 Core commit 会按 `draft graph -> verify -> stop plan -> start plan -> CommitSummary` 推进；启动失败不发布半启动 Plugin，required dependents 被阻塞，无关分支仍可继续。它不能直接等同于论文中整个 Context transition 的形式化事务。

## Isolation 与 interception：有局部对应，没有通用代数

论文的 isolation 将 logical key 映射到 realm，再从 realm 解析具体 value，使相同 dependency name 可以在不同 Context 分支取得不同 implementation。Pluxel 每个 Plugin 有独立 owner Context，fork/node address 区分实例，logger、effects 等服务也能保留 Plugin 隔离；但 Pluxel 没有任意 Context key 的 runtime realm remapping。业务 provider 的选择属于 graph node 与 dependency edge。

论文的 interception 合并 Context-carried metadata 与 component-declared metadata，在不改变“依赖是否满足”的前提下改变能力的使用方式。Pluxel 的 caller-bound Plugin view、owner-bound capability handle、invocation gate，以及 logger、database、cache、rates 等服务自己的 policy，都体现了类似的调用适配；但它们是领域协议，不是通用的 `intercept(key, metadata)` 或 metadata monoid。

这一区分很重要：Pluxel 的 Context capability 是生命周期和调用者边界，不是恶意代码的安全沙箱。Plugin 仍运行在同一 JavaScript 进程，能够导入 Node API 的代码也能够绕过 Context。

## Loader、HMR 与动态组成

论文把 declarative loader 视为时空可组合性的实际入口：配置描述目标组成，loader 比较现状与目标，再驱动 component/Fiber transition。

Pluxel 的 static/dynamic catalog、graph draft/build/commit 和 RuntimeState 承担相近职责。开发期由 Vite Module Runner 维护真实 module/importer graph；源码 add/change/unlink 进入正常 catalog transaction，再由 Core 执行 replacement lifecycle。旧 generation 的 effects、Workbench grants 和 capability handles 随 owner 撤销，失败的 candidate 不应把半成品发布为 active source。

但两者的事务边界不能直接画等号。Pluxel 将 module compilation、source publication、Core lifecycle、数据库实例与 UI artifact 分成各自明确的 transaction 或 last-known-good 边界；Core graph commit 本身不是对所有外部世界的原子提交。使用方式见 [Host 形态与装配](./getting-started/host-setup.md#动态模式)，诊断边界见 [CLI 与工具链](./development/tooling.md#hmr-diagnostics)。

## 论文开放问题在 Pluxel 中的落点

### System boundary

论文指出，只有 runtime 能独占修改并执行恢复的位置，才真正位于可逆边界内。已经发往外部系统的邮件、消息或对象存储写入，不会因为 Fiber dispose 自动消失。

Pluxel 也明确保留这条边界。进程内 registration、timer、route、handle 和连接可以进入 effects；数据库修改依赖数据库 transaction。数据库状态与 S3 等外部 emission 协调时，需要显式 state machine、transactional outbox、幂等 key 和 compensation，而不能把 cleanup 当作分布式回滚。参见 [对象存储](./runtime/storage.md#生命周期fork-与一致性)与 [数据库](./runtime/database.md)。

### Service multiplexing

论文讨论用 broker 同时承载多个 service implementation、版本切换或 rolling update。Pluxel 的 commands catalog、共享 worker pool、Workbench resource registry 等都有领域化 multiplexing，但没有通用 service broker。普通 Plugin replacement 也不承诺零停机 rolling update：默认生命周期仍是停止受影响的旧 generation，再启动新 generation。

### Dependency identity、typing 与 versioning

论文指出，纯 key identity 会遇到 key collision、interface drift 和版本协商问题，并讨论 package namespace、peer dependency 与 structural compatibility。

这是 Pluxel 回应最直接的部分。具体 Plugin identity 来自 canonical package entry、root named export 与 node/fork；required constructor 的 value import 同时提供 package provenance。它避免仅凭一个全局字符串把无关能力误认为同一个 provider，构建工具也能据 semantic facts 维护 peer dependency metadata。

这些约束仍不能证明 behavioral compatibility。两个版本即使拥有同一个 export identity 和可赋值类型，也可能改变运行语义；semver、迁移策略和领域契约仍然不可省略。

### Cycles、granularity 与语言边界

Pluxel 在 graph verify 阶段拒绝 required/optional ordering cycle 和 missing dependency。内部对象默认使用普通 class/function 与 effects，只有需要独立配置、启停、失败传播或治理时才提升为 Plugin；必要时可以用 integration Plugin 拆开双向业务关系。这是一套建模约束，不是自动解决所有领域循环的算法。

Pluxel 也不追求论文设想的语言无关 Context protocol。它有意依赖 TypeScript source、Vite/Rolldown semantic pipeline 和 JavaScript runtime。这个选择换来了 constructor provenance 与构建诊断，同时限定了它的适用边界。

## 我们可以声称什么

基于以上对应，Pluxel 可以声称：

- Plugin generation 对已登记资源具有明确的时间所有权；
- required/optional graph 变化会形成确定的停止、启动和失败传播计划；
- provider replacement 不会把旧 generation instance 当作当前依赖继续注入；
- static 与 dynamic host 复用同一套 graph 和 lifecycle 语义；
- business dependency identity 在构建期来自 package provenance，而不是运行时字符串约定。

Pluxel 目前不能声称：

- cleanup 已被证明是 effect 的数学逆；
- 任意 effect 之间满足 independence 或 observational equivalence；
- lifecycle transition 已有 preservation、progress 或 confluence 的形式化证明；
- Context 是通用 capability sandbox；
- 外部 side effect 会随 generation 自动回滚；
- 它完整实现了 Cordis 论文的 Context/Fiber calculus。

## 设计结论

Cordis 论文为 Pluxel 提供了一组比“有没有 Proxy”或“有没有 HMR”更准确的比较坐标。沿着这些坐标看，Pluxel 并没有绕开时空可组合性：generation effects 回答时间问题，lowered Plugin graph 与 commit 回答空间问题，owner-bound capability 则守住两者进入真实 I/O 时的边界。

真正不同的是统一程度和解释时机。Cordis 选择让 Context/Fiber 在 runtime 持续解释一个开放环境；Pluxel 选择先固化能够从源码获知的业务组成，再让 runtime 只处理 generation、显式 graph change 和宿主能力。前者保留更强的 late binding，后者换取更强的 provenance 与更窄的动态表面。

这不是谁已经解决了对方没有解决的问题，而是两种 runtime 对复杂度位置的不同选择。Cordis 的形式模型也提醒 Pluxel：工程不变量只有在边界、异步和失败场景中持续接受检验，才真正构成可组合性，而不只是一次成功启动。
