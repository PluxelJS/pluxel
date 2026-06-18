# Runtime Update Rationale

更新日期：2026-06-19。

本文记录近期设计讨论得出的推进判断。结论不是“这些改动纯粹正向且零成本”，而是：这些改动用小范围 core 复杂度换取全局状态协调复杂度下降，长期值得，但必须分阶段推进。

## 总判断

足够驱动我们继续做，但不应该一次性全做。

当前最值得推进的是 Phase 2：Declaration ownership 下沉到 core。它能直接删除 HMR/loader 对 core draft、rollback、retry 的重复协调逻辑，属于明确的高收益改动。

完整 PluginKey graph 是长期正确方向，但风险更高。它会触碰 DI graph、fork、base provider、dependency override、status read model，应在 Phase 2 稳定后再小步推进。

## 收益对象

### runtime-dynamic

runtime-dynamic 收益最大，因为它有最多状态面：

- workspace scan
- package install / remove / refresh
- module evaluation
- HMR
- missing deps retry
- loader batch
- core registry draft

Phase 2 和后续 PluginKey 对 dynamic 的收益：

- HMR 不再知道 core draft rollback 细节。
- missing-deps retry 不再需要外层 re-sync modules。
- constructor identity mismatch 的补丁可以删。
- package refresh / reload 可以复用同一套 declaration update 语义。

### runtime-static

runtime-static 也受益，但收益类型不同。

static 没有 scan/package/Vite runner 这些动态状态面，所以短期收益不如 dynamic 明显。它的收益主要来自：

- static catalog diff 可以使用同一套 `upsertModule` / `removeModule` 语义。
- static HMR 或 catalog refresh 不需要自己拼 register/replace/unregister。
- removed plugin / catalog drift rollback 更清楚。
- PluginKey 能让 static definition 的插件身份更稳定，不依赖某次 import 得到的 constructor 引用。
- fork/base provider/status read model 可以和 dynamic 共享同一套身份语义。

因此这些设计不是只为 runtime-dynamic；dynamic 是最强驱动力，static 应共享 core 能力，而不是另做一套。

## 性能损益

这些改动不是零成本。

### 预期成本

- core 会多维护一层 runtime declaration ownership。
- update/commit 边界会多 declaration registry / journal bookkeeping。
- PluginKey graph 会在 graph build 阶段增加 key normalization。
- 迁移期会有 compat resolver / alias 逻辑，短期代码复杂度会上升。

### 预期收益

- HMR/loader 少做外层 re-sync、resetDraft、retry 拼接。
- 复杂 HMR / missing deps retry 的重复 work 减少。
- constructor identity mismatch 的长期补丁可以删除。
- adapter 通过稳定 commit summary 观察更新结果，减少读取内部状态。

### 性能边界

允许新增成本的位置：

- declaration update
- graph build
- commit
- commit summary construction

不允许新增成本的位置：

- 插件实例方法调用
- 每次依赖访问
- plugin lifecycle hot path 内的全局 registry Map lookup
- UI/worker artifact 编译进入 core commit critical path

只要新成本停留在 declaration/commit/build 边界，性能风险可控。

## 分阶段判断

### Phase 2：Declaration ownership 下沉

收益确定性最高，应该先做。

它的价值不在“架构更完整”，而在能删除现有重复协调：

- HMR/loader 不再直接管理 core draft rollback。
- retry 不再需要外层重新 sync declarations。
- static catalog diff 也能使用统一 runtime update 语义。

成本：

- core 局部复杂度会上升。
- declaration registry 需要 journal/undo log，不能 deep clone 全量 registry。

接受条件：

- API 保持极小：`upsertModule`、`removeModule`、commit/rollback。
- 不引入 driver/provider/kernel 抽象。
- 至少删除一部分 HMR/loader re-sync 或 rollback 逻辑。

### 截至当前停点的实际收益

截至 2026-06-19，Phase 2 已经兑现的收益主要是：

- committed runtime module ownership 已经成为 core 的稳定事实来源，而不是 loader commit 后补同步的影子状态。
- HMR commit 内的 ownership 可见性已经对齐；`afterCommit` 消费方不再需要接受 ownership 落后于 summary 的时序差。
- adapter/loader 的一部分重复 committed read-model 已被删除或降级为按需推导，典型例子是 `name2ExportKey` 和 `findModuleId(..., ctor)` 的线性扫描分支。
- Phase 2 的“不要再继续下沉”的边界也已经变得清楚：`missing-deps retry` 仍然依赖 loader/config re-apply 语义，继续硬推只会污染 core。

这意味着 Phase 2 的边际收益已经明显下降。继续停留在 Phase 2，大概率只会得到更多“看起来更架构化”的抽象，而不是继续删除真实复杂度。

### Phase 3：PluginKey graph

长期收益最大，但不应直接大改。

它解决 constructor identity 漂移的根因：

- 同一个 plugin id 的不同 constructor 引用不再破坏依赖解析。
- constructor 只表示某次 module evaluation 的 implementation。
- plugin identity 由 `PluginKey = id + fork` 表示。

成本和风险：

- DI graph、fork、base provider、dependency override、status read model 都会受影响。
- graph build 会多 key normalization。
- 迁移期 alias/compat resolver 会增加复杂度。

接受条件：

- 能删除 HMR path 上的 constructor token normalization。
- graph 内部仍编译为 slot/array，不让业务热路径做 string Map lookup。
- 分批迁移 constructor API，不一次性破坏现有 plugin authoring。

### Commit summary 升级

低风险，值得做。

原因：

- summary 构造发生在 commit 边界，性能影响小。
- adapter、UI compiler、worker watcher、status/workbench consumers 可以少读内部状态。

限制：

- 不做事件溯源。
- 不做全量 update log。
- 不用 summary 反向驱动 core 状态。

### missing-deps retry 收进 transaction

中等收益，值得在 Phase 2 后做。

原因：

- 能删除 HMR/loader 外层 retry re-sync 逻辑。
- retry 策略属于 runtime declaration update，不应散落在 adapter pipeline。

限制：

- 只支持现有窄策略，例如 `disable-and-retry`。
- 不做通用 policy engine。

## 停止规则

每一步都必须能删除现有复杂度。如果一个改动只新增抽象，但删不掉旧补丁或重复协调逻辑，就不应该合并。

具体停止规则：

- Phase 2 如果不能减少 HMR/loader 的 re-sync/rollback 逻辑，就停止。
- PluginKey 如果不能删除 constructor token normalization，就停止。
- commit summary 如果开始演变成事件溯源或全量日志，就停止。
- retry option 如果扩成通用 policy engine，就停止。
- 任何改动如果进入插件业务热路径，就停止并重新设计。

## 明确否决

这些不是当前设计的一部分：

- 把 Vite module graph 抽进 core。
- 恢复 ops/MCP runtime 接入。
- 在 runtime 内核里保留 MCP carrier glue。
- 抽 `RuntimeKernel + SourceDriver + ArtifactProvider`。
- 把 UI federation、worker、static build 的 artifact 编译生命周期塞进 core commit。

未来如果重新讨论这些方向，必须有新的约束或证据，而不能把它们当作本轮设计的自然延伸。
