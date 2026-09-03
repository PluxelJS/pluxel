# Testing API redesign proposals

> 状态：研究中。这里的内容尚未实现，也不是当前 API 权威。当前测试方式仍以
> [`../../../docs/development/testing.md`](../../../docs/development/testing.md) 为准。

这个目录集中记录 Pluxel test API 的重新设计。目标不是给现有测试 helper 逐个增加 alias，而是让 Plugin 作者和
coding agent 能从所验证的产品边界直接推导出最短、正确的测试路径。

## 设计目标

新的 test API 应优先满足以下约束：

1. **测试代码直接表达产品行为**：启动 Plugin、调用 HTTP/RPC、观察公开结果和资源回收，不要求调用方理解 Core slot、
   Workbench registry、reconciliation transaction 或 transport wiring。
2. **默认经过真实框架边界**：Plugin source 继续经过 semantic lowering；graph、config、lifecycle、Context ownership 和
   capability withdrawal 使用生产实现。测试只替换不属于目标边界的物理 carrier 或外部系统。
3. **一个意图一个入口**：不同时提供 `mock*`、`simulate*`、`driver*` 和 `client*` 等语义重叠的 helper。名称应说明调用的
   是真实测试边界还是测试替身。
4. **失败位置清晰**：fixture/setup 错误可以抛出；Plugin 可分支的领域失败继续使用生产 discriminated result/error；测试
   helper 不把二者压成字符串。
5. **资源所有权可见且容易正确**：保留 session、RPC capability、listener 或进程资源的 helper 必须返回与仓库惯例一致的
   disposable handle，并保证重复释放安全。
6. **Capability 默认值保持真实**：Workbench/Vault 不被测试偷偷启用；Database 保留 Runtime 的惰性 PGlite baseline；helper
   不能在 root 创建后补装 capability。
7. **Agent 的局部信息足够**：常规测试应能依靠 TypeScript autocomplete 和一个短示例完成；不要求先搜索 internal tests
   复制 registry、observer、canonical address 或 Cap'n Web disposal 样板。
8. **复用 runner 已有语言**：Core/Runtime host 保持 runner-neutral；official Vitest preset 只为 runner 无法理解的 Plugin lifecycle
   identity 增加一个 matcher。普通 object/error/poll/type assertion 不建立 Pluxel wrapper。
9. **smoke 也使用可释放 lease**：真实 dev server 应以一次 `await` 达到 ready，并暴露标准 URL；不要让 coding agent 自己发现随机端口、
   轮询 readiness 或拼装 Vite teardown。

## 不把所有测试统一成一种 host

API 一致性不等于抹平测试边界。重新设计仍应区分：

- 普通纯函数和领域对象测试；
- Core graph/config/lifecycle test host；
- Runtime capability test host；
- static/dynamic route、Vite/HMR 和 artifact integration；
- Node/WebSocket 等真实 carrier conformance；
- Workbench Shell 的 React/browser 测试。

低层 host 不应为了统一外观安装高层 Runtime 能力，普通 Plugin 测试也不应为了调用一个 RPC action 启动浏览器或物理端口。

## 当前提案

- [`COMPOSABLE_HOST.md`](COMPOSABLE_HOST.md)：重新设计 Core/Runtime test host；Core 使用真实 `add/remove`，Runtime 使用真实
  `start/stop`，共同以立即完成的常用行为和 callback-scoped `commit` 取代长期 staging，并分开 public author host 与 framework
  internal harness；strict success 只返回完成信号，official Vitest adapter 提供唯一的 lifecycle issue matcher。
- [`WORKBENCH_RPC.md`](WORKBENCH_RPC.md)：为 Plugin 测试提供类型化、进程内的真实 Workbench RPC entry opener，删除各
  Plugin 重复的 internal registry/session 样板，不模拟 DOM 表单和点击。
- [`DIRECT_RPC.md`](DIRECT_RPC.md)：区分纯 `RpcTarget` object contract 与直接挂载到 `ctx.elysia` 的业务 RPC endpoint；前者
  使用 local capability membrane，后者必须按 Fetch 或 WebSocket carrier 的真实边界验证。
- [`DEV_SERVER_SMOKE.md`](DEV_SERVER_SMOKE.md)：为 dynamic Runtime 定义真实 Vite/Node listener 的一次启动式 disposable lease；让
  coding agent 可以用标准 `fetch`、WebSocket 或 browser 做 physical smoke，同时不向 dev server 暴露 test-host Plugin mutation authority。

## 后续议题

后续提案应分别回答问题，不在第一个 helper 中预留未经证明的抽象：

- internal Core/Runtime test harness 的最终 subpath 与非稳定性标注；public host 已选择只保留 explicit disposable factory；
- Plugin fork 未来的产品删除决策；本次 test v2 已选择暂时保留并使用无 mutation typed ref；
- external HTTP/database/worker/clock fixture 的最小标准 seam；
- 各 domain 已有 cancellation/deadline 是否足够覆盖长任务，哪些地方仍缺少可注入 clock 或 readiness seam；
- static artifact integration 与 dynamic dev server 在真实调用点中是否出现足够相同的 lease contract，值得提取 carrier-neutral 命名；
- callback-scoped commit、teardown 聚合与 diagnostics 的 prototype 是否能保持已有 structured failure facts。

只有真实调用点和重复样板证明需求后，才为这些议题增加公共 surface。

## 提案完成规则

某项提案被采纳并实现时必须：

1. 更新对应 package public exports 和类型测试；
2. 把当前用法写入 `docs/development/testing.md`；
3. 迁移至少两个真实 Plugin 测试，证明 API 不只适合 synthetic fixture；
4. 添加 enabled/disabled、failure 和 cleanup 验证；
5. 为用户可见的 public test package 变更添加 Tegami changelog；
6. 从本目录删除已实施内容，或只保留仍未实现的决策边界。
