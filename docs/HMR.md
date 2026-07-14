# HMR Architecture

HMR replacement 必须保持 core lifecycle、Workbench resources 和 UI artifact 同步：

```text
module batch -> committed graph -> stop old owner/effects -> start new owner
             -> mount module/resources -> compile artifact -> Workbench revision
             -> Workbench refetch target layouts -> lazy load new remote
```

`WorkbenchCompilerService` 位于 `packages/runtime-dev/src/workbench/`，dynamic/static route 只负责提供
Vite server、plugin directory 和 host policy。旧 artifact 可短暂保留在磁盘供 inflight import 完成。
artifact 编译状态只推进 catalog/layout revision，不撤销资源 grant；module、实例或依赖资源图变化会推进
独立的 grant revision，并让旧 layout binding 立即失效。这样 UI-only HMR 不会制造无效 binding 竞态，
也不会放宽资源图变化时的 capability 撤销语义。

测试至少覆盖 module replacement cleanup、compile error state、cached artifact、target layout refresh 和
disabled Workbench Plane。

## Workbench UI Federation 构建隔离

`buildWorkbenchUiRemote()` 把每个 remote 作为独立 staging transaction 构建、校验并原子发布。
相同 build key 的请求在进程内合并；同一输出目录的不同请求按整条 transaction 串行，避免较早构建在
较晚构建之后覆盖目标目录。

截至 `@module-federation/vite@1.16.16`，上游 builder 仍不是 reentrant：
`normalizeModuleFederationOptions()` 会覆盖 module-scoped `config`，VirtualModule registry、
`hostAutoInitModule` 和部分 shared caches 也属于模块级单例；manifest 和 bundle hooks 会在稍后重新读取这些
状态。因此同一 Node.js 进程内并发执行两个 `vite.build()` 会发生 remote name、virtual entry 或 shared
配置串扰。Pluxel 将实际 Federation builder 调用建模为 process-wide exclusive resource；源码 hash、缓存
检查等前置工作仍可并发，精确相同的构建仍会去重。项目不应再通过 `compileConcurrency: 1` 自行规避。

升级上游后不要凭版本号删除该隔离。移除前必须同时确认：

1. normalized options 和所有 VirtualModule/cache registry 已改成 federation instance ownership；
2. 不同 package root 的并发 remote 回归用例允许 builder 临界区重叠后，连续运行仍得到各自正确的
   manifest name、entry 和 UI marker；
3. 同输出目录的 transaction queue 继续保留，它解决的是 Pluxel 自身的发布次序，与上游是否 reentrant
   无关。

Workbench 的 Federation host 和 `remoteName -> cache-busted entry` registry 保存在 `globalThis` 的
`Symbol.for('pluxel.workbench.federation-runtime')` 状态中，以跨越 Vite module HMR。相同 entry 的多个 view
load 是幂等的，不重复 `registerRemotes()`；只有 `sourceHash` 或 `compiledAt` 改变后才以 `force: true` 替换
remote。不要把该状态退回普通 module local，否则同一插件的多个 view 和 HMR 重载会反复清除 MF remote
cache 并产生 `already registered` 警告。
