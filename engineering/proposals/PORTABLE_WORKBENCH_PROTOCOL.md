# Portable Workbench View Host

> 状态：research proposal。Level 1 Management Host 已进入当前架构；本文只保留尚未标准化的 Level 2 Remote View host。
> 当前事实以 [`../WORKBENCH.md`](../WORKBENCH.md) 和 [`../FRONTEND.md`](../FRONTEND.md) 为准。

## 剩余问题

第三方 host 已能通过 `@pluxel/runtime/web` 完成 discovery 与通用管理，但要承载现有 Plugin Remote View，仍需依赖官方
Workbench 的 internal layout/session/artifact/grant transport。下一步不是再设计一套 management API，而是判断哪些 View-host
事实值得成为稳定、browser-safe 的 SDK 与 renderer ABI。

目标关系：

```text
versioned layout + artifact + opaque grant
                    │
          framework-neutral host runtime
                    │
          renderer adapter: React ABI 1
                    │
       third-party shell / official Workbench
```

Shell 可以是 Vue、Svelte、vanilla 或 React；第一阶段 Plugin View 仍是 React。Shell 可替换与 Plugin 作者可任选 renderer 是两个
独立问题，不因实现前者而承诺后者。

## 必须保留的当前不变量

- owner/target 使用 canonical `PluginNodeAddress`，不从 label、class name 或 package title 推导 identity；
- layout、artifact、grant、RPC/live query/events 与 owner generation 共享 withdrawal 语义；
- cached client 不能在 grant 或 generation 撤销后自动按 namespace 重新取得能力；
- host 只注入 locale、scheme、notification、confirmation、受限 navigation 和 route params 等语义能力；
- Contract、layout、resource transport 和 Plugin lifecycle 不因 renderer 改变而复制；
- Workbench disabled 时不创建 View-host SDK、artifact loader、session、route 或 stream；
- third-party Level 2 host 不 import official Workbench App、runtime-dev compiler 或 server internal entry。

## 需要做出决策的四个边界

### 1. Host runtime 的最小职责

候选 browser-safe runtime 只拥有可跨 Shell 复用的状态机：

- discovery 后校验 required View-host feature；
- catalog/global layout/target layout snapshot 与 revision-gap recovery；
- target reference lease、session cleanup 与 owner withdrawal；
- artifact load、Contract fingerprint 校验和 last-known-good replacement；
- opaque grant-bound RPC/live query/events client；
- route table、params、Port resource 与 host capability 注入。

React hooks、router、Tab/workspace store、Mantine notification、split layout 与官方产品页面必须留在 adapter/App。只有外部 fixture
能不复制 official App 状态机时，才说明这条提取边界成立。

### 2. Renderer 与 delivery ABI

artifact 必须显式描述 renderer，而不是从 Remote module shape 或 shared list 猜测：

```ts
type RendererRequirementV1 = Readonly<{
	kind: 'react'
	abi: 1
	requiredFeatures: readonly string[]
}>
```

Module Federation 可以继续作为 React artifact delivery implementation，但 MF runtime object、share scope 和 loader hook 不进入
Pluxel public protocol。需要稳定的是 artifact identity、entry/assets、Contract fingerprint、renderer requirement、setup/replacement/
cleanup 结果。

整数 ABI 负责破坏性 renderer contract；feature set 只表达同一 ABI 内可独立协商的 optional capability。没有真实 required feature
前保持空集合，不提前发明 feature taxonomy。

### 3. Shared runtime 的最小集合

第一轮实验只把以下项目视为 mandatory singleton candidate：

- `react` 与 `react/jsx-runtime`、`react/jsx-dev-runtime`；
- `react-dom` 与实际 renderer entry；
- `@pluxel/runtime/workbench/ui` 的 React adapter identity。

browser-safe Contract 应随 artifact 正常打包，不因只含 value/type 就强制 singleton。Mantine、Tabler、react-virtual、router、state
library 和 Worksplit 都不是所有 View 的 ABI；把它们加入 mandatory set 会让不使用它们的 Plugin 和第三方 host承担无关依赖。

如果官方 Mantine View 确实依赖唯一 Provider/theme identity，应由显式 optional renderer profile/adapter 满足，并用一个真实官方
Plugin 验证；不能把该需求悄然升级成所有 React View 的基础 ABI。

### 4. CSS 与 asset ownership

默认方案是 artifact 声明完整 assets，host 按 artifact revision 引用计数加载并在最后 lease 撤销后清理。加载顺序、重复 URL、失败
回滚和 last-known-good replacement 必须有测试。

Shadow DOM 或 iframe 只在真实 Plugin 证明普通 asset ownership 无法控制选择器冲突、reset 或安全边界后成为 opt-in renderer mode。
它们不能作为未经测量的默认，因为会改变 portal、focus、theme、font、navigation 和 resource bridge 语义。

## 实验顺序

1. 从 official client 中提取不依赖 React/Mantine/router/store 的 target session state machine，但暂不公开 package entry。
2. 定义只覆盖现有 React View 的 artifact/renderer descriptor，并为 unknown ABI/required feature fail closed。
3. 做一个非 Mantine external Shell fixture，承载至少一个同时使用 RPC 与 live query/events/Port 的真实 workspace Plugin View。
4. 覆盖 cold load、concurrent target、StrictMode replay、HMR replacement、grant withdrawal、asset failure、last-known-good 与 cleanup。
5. 比较提取前后的模块数、公共类型数、状态 owner 数、bundle shared set 和 fixture 代码；只有净删除 official-only interpretation 才公开 SDK。

不先建立 Vue/Svelte Plugin renderer，也不先暴露 generic adapter registry。一个 React island 足以验证“Shell 可替换”；多 renderer
必须等待真实非 React Plugin 和第二个 renderer implementation。

## 验收条件

- 同一个构建后的 Plugin package 可同时运行于 official Workbench 和非 Mantine fixture，不重新编译或修改作者代码；
- fixture 只依赖 public browser entry，不复制 official App store、raw internal endpoint parser 或 Mantine provider；
- identity、revision gap、artifact failure、grant expiry、owner replacement 与 official host 得到同一稳定结果；
- owner stop/replacement 后，两个 host 的 cached RPC/query/event client 都不能越过旧 grant；
- target lease 与 asset reference 在 StrictMode replay、并发 target 和异常 setup 下不泄漏、不重复终止唯一 runtime；
- 不使用 Mantine 的 View 不下载或要求 Mantine singleton；
- host runtime package 不 import React，React adapter package不 import official router/store/split；
- Workbench disabled/headless management fixture不构造任何 Level 2 runtime。

## 否决条件

- public SDK 只是把 official App class 改名导出，仍要求调用方理解其 store 或 router；
- artifact descriptor复制 Contract/layout/resource schema，形成第二套 View 语义；
- 为假设性 renderer 增加 adapter registry、作者声明或 mandatory dependency；
- CSS isolation 方案让普通 View 默认承担 iframe/Shadow DOM 的 portal、focus 和 bridge 成本；
- third-party fixture 仍必须 import `/web/internal`、runtime-dev 或 official Workbench source；
- 新 public abstraction 没有删除任何 official-only状态、parser 或调用分支。

## 最终未决问题

1. React adapter 放在现有 `@pluxel/runtime/workbench/ui`，还是形成独立 `workbench/host/react` entry，哪一种依赖方向更窄？
2. `@pluxel/runtime/workbench/ui` 是否必须 singleton，还是只需一个更小的 host bridge identity package？
3. Mantine official View 的 Provider 需求能否由 optional profile 解决，还是应由这些 artifact 自带隔离依赖？
4. 第一个 external fixture 应优先验证 Port，还是 events/live query；哪个能覆盖更多 session/withdrawal 风险？
5. 何种实测 CSS 冲突足以触发 opt-in Shadow DOM/iframe，而不是修复 asset ownership 或选择器作用域？
