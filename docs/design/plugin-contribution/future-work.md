# Plugin UI Future Work

这份文档只记录未来应该继续做的优化和清理。

目的很简单：

- 不把“已经接受的当前设计”写成永远还在摇摆
- 不把未来事项散落在 issue、聊天记录和临时注释里
- 明确哪些是架构债，哪些只是工程整理

当前已经接受的基线设计见：

- [overview.md](./overview.md)

## Priority Order

### P0

- MF2 dev/build 临时隔离方案收敛
- extension loading / runtime state 链路继续去重
- interaction session 与 diagnostics 的统一边界再收紧

### P1

- plugin UI authoring API 再减法
- builtin/custom frontend 文档和 demo 再统一
- loader / registry / runtime diagnostics 的测试面补齐

### P2

- 更细的性能优化
- 文档拆分与导航整理

## 1. MF2 Temporary Design

当前 `@module-federation/vite` 在 dev/build 链路里的使用，仍然带有明确的临时设计痕迹：

- 同 root 只复用调度器，不复用 federation build 进程状态
- 每次真正的 remote build 都走一次隔离子进程
- 每次 build 只清理自己创建的 isolated cacheDir

这套方案现在是合理的，因为它优先保证稳定性和结果可预测；但它仍然是“围绕 MF2/Vite 当前行为做的工程隔离”，不是最理想的最终模型。

未来应继续做的事：

- 追踪并验证上游 `@module-federation/vite` 的状态污染问题是否已经根治
- 如果上游能力足够稳定，重新评估是否还需要“一次 build 一个子进程”
- 如果仍然需要本地兜底，尽量把隔离逻辑继续压缩在 `packages/hmr/src/plugin-build.ts`
- 明确缓存边界：哪些缓存可以跨 build 安全复用，哪些必须强制隔离
- 给这条链路补更明确的 benchmark，确认现在的稳定性换来的性能成本是否仍然可接受

完成标志：

- 不再把“MF2 临时隔离”当成默认永久设计
- `plugin-build` 的隔离/清理逻辑能被一句话解释清楚
- HMR 文档里不再需要强调“这是为了绕开上游污染”

## 2. Extension Loading Spine Cleanup

当前 `ExtensionLoader` 已经承担了：

- manifest 拉取
- module warm/load/unload
- builtin/session 注册同步
- runtime diagnostics/state 同步
- SSE 与 polling 的协同

这已经是合理的一层，但仍然偏重。

未来应继续做的事：

- 继续收紧 `ExtensionLoader` 的职责，让它更像“编排器”而不是“所有细节都在里面”
- 把 manifest apply / module cache / builtin sync / session sync 这些内部子流程拆成更明确的局部单元，但不要过度抽象成小工具地狱
- 保持 `runtime-state` 只做状态快照与通知，不反向承载业务策略
- 明确哪些逻辑属于 host runtime invariant，哪些只是 UI 自愈行为

完成标志：

- `ExtensionLoader` 还能继续读得懂，但主流程更短
- manifest 同步和 module 同步各自有独立的边界与测试

## 3. SignalDB Authoring And Runtime Polish

当前方向已经正确：

- 插件作者统一从 `plugin.use().db` 进入
- SignalDB 响应性建立在 official adapter/runtime 之上
- 服务端 collection 负责 authoritative state

未来还可以继续精进：

- 再检查 `useLiveQuery()` 的使用边界，避免它重新变成万能兜底入口
- 明确单文档、列表、聚合三种读取模式的推荐层级
- 继续减少插件作者手写不稳定 selector/spec 对象的机会
- 评估是否需要再补少量高价值 helper，但不能重新把 API 面积做大

完成标志：

- demo 与文档里主要只剩稳定的 2-3 种使用姿势
- 不需要在文档里频繁解释“这个 hook 和那个 hook 的区别”

## 4. Interaction Session Model

当前 interaction session 已经把宿主、provider、consumer 的 ownership 分开了，但还可以继续收敛：

- `surface / offer / session / diagnostics` 这四块已经形成闭环
- 但 session runtime handle、diagnostics snapshot、host render 容器之间还有继续统一的空间

未来应继续做的事：

- 再检查 session handle 的命名和导出边界，避免 authoring API 与 runtime transport API 混在一起
- 确保 diagnostics 真的是 interaction registry 的派生结果，而不是多个来源拼接
- 让 “why this offer matched / did not match” 更容易被宿主直接显示

完成标志：

- session 生命周期可以用一条清晰流程描述清楚
- diagnostics 不需要依赖额外补丁状态

## 5. API Surface Reduction

当前这轮重构已经做了明显减法，但未来仍要持续警惕导出面重新膨胀。

重点原则：

- 插件作者优先记住一条主入口，而不是一组平行入口
- service side 与 browser side 不各自发散出多个近似 helper
- runtime internal helper 不要轻易提升为 public API

未来应继续做的事：

- 周期性检查 `@pluxel/runtime/web/ui` 导出面
- 周期性检查 `packages/components/src/extension/index.ts` 是否暴露了过多内部实现细节
- 对新增 helper 采用更严格门槛：没有明确减少错误率或重复代码，就不要加

完成标志：

- 绝大多数插件文档示例都能只围绕极少数主 API 展开

## 6. Demo And Documentation Cleanup

当前 demo 已经承担了“设计证明”的角色，因此未来整理重点不是加更多 demo，而是去掉重复表达。

未来应继续做的事：

- 合并重复说明，减少 runtime README、architecture、design 文档之间的镜像段落
- 保证每个 demo 都有单一目的，不要一个 demo 同时承担过多概念
- 把“临时 workaround / 已知上游限制 / 未来优化方向”集中写在这类 future-work 文档，而不是散落到 README

完成标志：

- 文档分工明确：
  - design：为什么这么设计
  - architecture：代码和运行时如何串起来
  - README：怎么用
  - future-work：以后再做什么

## 7. Test And Benchmark Gaps

还应该继续加强的不是“多写一些测试”，而是补真正会挡住回归的测试。

未来应继续做的事：

- 增加 extension loader 与 manifest/state 自愈链路的集成测试
- 增加 interaction session 生命周期测试
- 增加 plugin-build / MF2 隔离链路的性能对比基线
- 对最容易回归的 authoring helper 保留窄而稳的 contract tests

完成标志：

- 以后再改 `ExtensionLoader`、`plugin-build`、`SignalDbService` 时，不需要靠手工 smoke 才能判断是否安全

## Non-Goals

这些事情当前不应该做：

- 为了“更统一”重新发明一套新的通用状态框架
- 为了“更灵活”再加第三条产品路径
- 为了“更抽象”把 builtin/custom frontend/session/config/signaldb 全塞进一个名词
- 为了“更优雅”把当前已经稳定的主路径重新打散

一句话：

未来优化的目标是继续收紧边界、减少重复、替换临时工程隔离；不是重新推翻这轮设计。
