# Module Federation 2.0 delivery

> 本文是 Workbench browser module system、shared policy 与 renderer lifecycle 的唯一 authority。
> MF 2.0 的 mandatory status 与 Profile 1 fixed host choices 由 [`PLATFORM_CONTRACT.md`](PLATFORM_CONTRACT.md) 决定。
> Server publication 见 [`PUBLICATION.md`](PUBLICATION.md)；business state/capability 不经 MF，见
> [`CONTROL_PLANE.md`](CONTROL_PLANE.md)。

## MF 2.0 是架构核心，不是可换 loader

Workbench 需要 independently built Plugin UI 进入同一个 Shell、按需加载、复用 singleton dependency、独立更新并获得标准诊断。MF 2.0
已经提供 producer/consumer、remote expose、Manifest/Snapshot、Federation Runtime、Runtime Plugins、share scope、动态类型、DevTools 与
Bridge lifecycle。

因此 vNext 不再定义：

- `ArtifactLoader`、plain ESM mode 或 Workbench-specific manifest；
- generic renderer adapter/Level 2 host runtime；
- Pluxel share resolver、preload protocol 或 remote registry；
- 由每个 Plugin 自选 bundler/runtime 形成的多个 federation universe。

Pluxel 只补充 MF 不拥有的 Plugin owner、generation、required dependency、placement、server capability 与 withdrawal。

## Plugin graph 到 federation graph

| Plugin/Workbench fact                       | MF/browser projection                                               |
| ------------------------------------------- | ------------------------------------------------------------------- |
| 带 UI 的 Plugin definition                  | 一个 producer/remote family                                         |
| UI build revision                           | immutable Manifest/Snapshot revision                                |
| local View                                  | producer 内一个 Bridge expose                                       |
| dependency Attachment renderer              | provider producer 内一个 expose；placement 属于 consumer            |
| Plugin node/fork                            | 共享 producer artifact；独立 PublishedTarget/opened View/capability |
| generation stop/replacement                 | withdraw publication/session；新 generation 重新关联 artifact       |
| TS View builder、PluginPart、shared library | source/build composition，不自动获得 producer/runtime identity      |

没有 Workbench UI 的 Plugin 不产生 producer。Dynamic Plugin 仍先经过正常 catalog/graph；只有 running generation 成功 publication 才进入
layout。Shell 实际打开 View 时才注册 remote 和请求 expose。Required dependency 本身不投影 provider 全部 UI；只有 consumer declaration
中的 Attachment placement 建立跨 producer composition。

Dynamic list/account/item 是 ViewApi 返回的 domain value，不是 producer、remote 或 expose。FontManager 创建 10,000 个 rows 或
BotManager 创建 10,000 个 accounts 都继续复用同一个 declared manager/picker Bridge expose；row 增删只走 Cap’n Web calls/callbacks，不触发 MF
registration。

## Producer、remote 与 expose identity

一个带 UI 的 Plugin definition/build revision 产生一个 producer，可包含多个 local View 与 Attachment renderer。每个 View 对应稳定 expose，
例如 `./views/bots/manager`；异步依赖与 CSS 由 MF build plugin 拆分。

```ts
type FederatedViewRef = Readonly<{
	producer: string
	manifest: string
	buildRevision: string
	expose: `./views/${string}`
	bridge: 'react'
}>
```

`producer`/`expose` 是 MF runtime identity，Plugin node address 是 server owner identity；两者不能互相替代或反推。Toolchain 根据 canonical
Plugin definition、producer entry 与 build revision 生成合法且无冲突的 name/expose。作者不手写 remote name、public path、share scope
或 manifest URL。

Workbench descriptor identity 也不由 MF name/expose 派生。Server lowering、producer build 与 generated
wrapper 使用 [`PUBLICATION.md`](PUBLICATION.md) 的 declaration identity；Attachment expose 只携带
provider declaration identity，consumer placement 由 host 与 server lowering 组合并在加载时匹配其
`provider` 字段。MF expose 只是该 declaration 在某个 immutable build revision 中的加载位置。

作者只用 `workbench.entry(import.meta.url, './ui.tsx')` 声明 module-relative renderer source。Profile 已固定 Vite、MF 2.0 与 React Bridge，
所以 public API 不再重复 `federation.react()` 这些不可选择的基础设施名词。Toolchain 把同一 Plugin definition 可达的 local Views 与
Attachment renderers 合并为一个 producer config，并生成 exact expose、Bridge wrapper、shared declaration、dynamic types 和
`mf-manifest.json`。`entry()` 不会被 server 当作 dynamic-import loader 执行；它只是 source provenance，publication 必须验证 declaration 与实际 expose
inventory exact。

## Manifest/Snapshot 是 artifact 唯一事实

`mf-manifest.json` 描述 remote entry、exposes、assets、shared 与 type files；Snapshot 支持 runtime registration、preload 与依赖图。Workbench
server/distribution 只维护“Plugin definition/build revision -> trusted manifest URL/hash”的 inventory，不复制 Manifest 字段，也不发布
`WorkbenchArtifactV2`。

`mf-stats.json` 只用于 build analysis/diagnostics，不成为 consumer runtime contract。所有 external manifest、Snapshot 与 expose metadata 在
browser trust boundary 验证。Dynamic types 只改善 Remote module 与 descriptor-bound hook projection 的开发体验；它既不替代 MF artifact/build revision 校验，也不让
Workbench 获得 Plugin domain validation 职责。

Layout 中的 `FederatedViewRef` 只是 pinned reference。Capability session 不承载 asset list，MF Manifest 也不承载 ViewApi/domain state、principal 或
grant。Manifest 请求失败不能改变 server publication authority。

## 页面唯一的 Federation Runtime

每个 Workbench page 恰好一个 MF Runtime instance。Official Shell 直接拥有：

- remote registration 与 immutable revision mapping；
- Manifest/Snapshot cache；
- shared scope 与 winner policy；
- Pluxel trusted Runtime Plugin；
- Bridge render/update/destroy orchestration。

Cap’n Web session 与 MF Runtime 由 Shell 通过 concrete opened View handle 编排，但互不包装：Runtime Plugin 不取得 raw control root；Cap’n Web target 不
fetch manifest 或 load module。Official Shell 是 reference implementation；React/Vue/Svelte/vanilla external Shell 可以直接消费相同
browser-safe federation/session packages。它们不能重写这段编排，也不需要 framework-neutral adapter layer。

## Trusted Runtime Plugin

Pluxel Runtime Plugin 只使用 MF 2.0 extension points 实现 host policy：

- fetch/manifest hook 注入 HTTP artifact credential、校验 distribution revision、记录 Manifest/Snapshot trace；
- resolve/script hook 把 logical remote location 投影到当前 immutable CDN/distribution URL；
- `resolveShare` 与 share lifecycle hook 验证 singleton/version policy；
- `errorLoadRemote` 只分类、记录和呈现当前 pinned artifact 的 load/activation failure；不替换 revision，也不暗示 offline control session；
- Bridge hook 关联 render/destroy trace、opened View lease 与 Plugin owner generation。

Business Plugin 不能注册 host-wide Runtime Plugin、修改 global Snapshot 或 share scope。Runtime Plugin 是 trusted Shell/toolchain extension，
不是第二套 Plugin system。

## Shared platform policy

Profile 1 shared set 由 Shell 与 `@pluxel/core/federation` 生成，producer 不得局部覆盖：

- React、ReactDOM 与必要 subpath 是 singleton，由 Shell 提供；
- MF Bridge、Workbench React runtime、ViewApi client 与 Pane Kit 是 version-locked platform shared；
- Mantine、Tabler、TanStack Virtual、router、workspace store、Worksplit 和普通领域 library 不进入 Profile 1 platform shared，
  由使用它们的 producer 自行 bundle/tree-shake；
- Profile 1 内不动态扩张 shared set；测量结果若证明必须增加 singleton，只能通过新的整体 profile version。

Profile 1 固定使用 `shareStrategy: 'loaded-first'`：Shell 在注册 remote 前先建立 platform shared winner，remote 保持 lazy
registration。React singleton version 不满足时 fail-fast，不能静默加载第二份。Profile 1 不提供 per-Plugin strategy 或 share scope；需要
React 主版本隔离时发布新的整体 profile，不在当前 profile 内增加 scope resolver。

验收以实际 bundle 与 MF DevTools 为准：React/ReactDOM winner 只有一个；optional UI foundation 未使用时不下载；platform shared hit、duplicate
dependency 与 winner trace 可观测。

## Bridge 是 renderer lifecycle

Profile 1 的每个 React View expose 返回一个 MF React Bridge application contract；每次打开 View 对应一个独立 Bridge application
instance，并与一个 local View handle/internal server lease 一一编排。Shell 通过 Bridge 完成 lazy load、render、update、error boundary 与 destroy，不把 unknown
remote Component 当作 local Component 直接塞进 Shell tree，也不在 producer 内增加第二套路由来复用 Plugin-wide application instance。

Bridge 的 generated wrapper props 只注入当前 opened handle 与稳定 host service，并立即建立每个 Bridge instance 独立的 React Context。Plugin
默认导出的零 props component 通过 `useWorkbench(exactDescriptor)` 取得：

- locale、scheme、notify、confirm；
- relative navigation；ephemeral state 留在 renderer，持久 state 走 ViewApi；
- document params、idempotent dirty marker 与 display title；无 remote `beforeClose` callback；
- capability-signed ticket 的 upload/download/progress/cancel helper；无 generic HTTP client；
- exact local ViewApi 或 Attachment provider/consumer clients；
- Pane Kit root。

Remote 不取得 Shell router、workspace store、Worksplit 或 raw transport。`LocalViewProps`、`AttachmentProps`、generated wrapper props 和 raw
`WorkbenchProvider` 都不是 public export；descriptor 参数同时完成 TypeScript projection 与 runtime identity check。Shared React/UI code 不代表共享
Shell private Context；remote 在自己的 application boundary 建 provider。CSS、portal、focus 与 cleanup 都跟随 Bridge lifecycle。

上游 React Bridge 支持通过 props 传数据，但那只是 Shell 到 generated wrapper 的 application ABI，不要求 Pluxel 把基础设施 props 继续扩散到每个
Plugin page signature。Context 内只保存 epoch-stable descriptor/stubs/host service；locale/scheme 等动态 host state 由 hook 订阅，Plugin domain
snapshot 不进入 Context。

Document/transfer facade 由 Shell 实现，但语义属于 concrete Profile 1 package，external conforming Shell 不能自行改写。Bridge
destroy 会幂等清除 dirty/title registration 和 active transfer，然后才 dispose opened View handle 持有的顶层 result。

Cleanup 顺序是硬契约：Bridge destroy 完成后才能 dispose opened View handle。Profile 1 的 Plugin producer 只接受 React Bridge；Vue/Svelte
producer 或另一种 Bridge implementation 需要新的整体 profile/version。这个限制不约束 Shell framework：MF Bridge 通过 DOM/application
boundary 允许 Vue/Svelte/vanilla Shell 承载 React remote application。

## Atomic View activation

Browser 只激活完整 tuple：

```text
target Plugin node + server generation lease
+ publication/layout revision
+ canonical descriptor identity
+ producer buildRevision + exact Bridge expose
+ opened root(s)/params
+ one Bridge instance
```

这些字段不是可互换的版本提示。旧 renderer 不得取得新 generation roots，新 renderer 也不得取得旧
generation roots。激活流程固定为：

1. 从当前 layout 选择 target/descriptor/build tuple；
2. `openView(expectedLayoutRevision)` 成功取得与同一 tuple pin 的 roots/ref；
3. 注册 immutable manifest revision，加载并验证 exact expose/Bridge contract；
4. 创建 Bridge instance，把 opened handle 只交给 generated wrapper；
5. 首次 render 成功后才把 tuple 设为 active；
6. 任一步失败都 destroy candidate 并 dispose candidate opened handle，不留下 partial root、remote registration ownership 或 document state。

已有 active tuple 只有在其 server generation lease 仍有效时才可以继续显示和调用。Owner/dependency
replacement 一旦开始 withdrawal，Shell 先 destroy old Bridge，再 dispose old opened handle；等待新 generation 的
新 layout 后按上述流程重新打开。中间可以显示 host-owned unavailable/loading document，但绝不把旧
Bridge 重新接到新 roots。

Artifact candidate staging 是唯一 pre-commit rejection boundary：build/distribution candidate 未通过
Manifest/expose/shared/Bridge contract validation 时，不进入已提交的 immutable artifact inventory，
当前完整 active tuple 完全不变。已经 pin 到 layout 的 revision 若 load/activation 失败，则 candidate
activation 失败并释放 opened result；Runtime Plugin 不尝试旧 revision。Artifact cache 可以继续保存旧
bytes，但 cache presence 不构成 authority、compatibility 或 fallback permission。

## Build、distribution 与 dev update

Profile 1 固定使用 host-owned Vite + MF 2.0 Vite plugin。当前 integration 的 module-scoped non-reentrant state 由
build isolation 解决，不公开为 architecture freedom：

1. 每个 producer build 隔离到 bounded worker/subprocess；
2. 不同 producer 可以并行，相同 output revision 只允许一个 atomic publication；
3. Vite/MF integration 必须通过 Manifest、dev update/reload 与并发 conformance；失败会阻塞 Profile 1，不在不同环境 fallback 到另一 compiler；
4. 不公开 bundler adapter，也不让 Plugin 或 deployment 自选 Vite/Rspack/Rsbuild。

Production 按 revision 发布完整 immutable MF output，纳入 distribution inventory、hash/signature 与 content-addressed cache。只有完整 build
candidate 验证成功才能进入 generation publication inventory；Cache 是 deployment optimization，不代替 Manifest/shared negotiation。

Profile 1 不实现页内 remote renderer HMR。Dev update 先构建并验证 candidate Manifest/exposes；失败
candidate 不提交。成功 candidate 原子提交 inventory 后触发 full-document reload。旧 document 在 unload
前只运行旧完整 tuple；新 document 重新 bootstrap、读取 layout、加载 exact expose 并 `openView()`，不
复用旧 roots 或 Bridge。

因此 upstream Vite remote-consumer HMR 不是 contract，也没有 revision swap、Bridge re-open 或
renderer/API compatibility guess。Vite HMR socket 仍可承载 toolchain update signal，但最终动作固定为
page reload；不能切换 bundler、plain ESM loader 或第二套 renderer path。

## Federation acceptance

- 一个 page 只有一个 MF Runtime instance；
- official Shell 与至少一个 non-React external Shell fixture 使用相同 concrete host packages 并被标记为 Profile 1 conforming；
- Plugin UI 只经 standard Manifest/Snapshot + remote expose 加载；
- 未打开 View 不请求其 manifest/expose，打开一个 View 不下载无关 expose chunk；
- different producer build 存在 bounded parallelism；
- Manifest、remote entry、expose、shared 与 Bridge failure 可以分阶段诊断；
- failed build candidate 不替换 artifact inventory；pinned artifact failure 不回退旧 revision；dev commit 后整页重载；
- React/ReactDOM singleton 与 shared winner 可由 MF DevTools 验证；
- remote 不 import official router/store/Worksplit；
- 不存在 Workbench artifact manifest、plain ESM loader、renderer adapter 或 custom share resolver。

## Federation 否决条件

- 把 MF 2.0 降成可选 delivery implementation；
- Plugin 自行读取 manifest、加载 remote 或协商 share；
- 每个 remote bundle 自己的 React/ReactDOM，或 version mismatch 时接受第二份；
- Workbench layout 复制 asset/shared/type inventory；
- Runtime Plugin 获得 Management root/business capability；
- 旧/new renderer、roots、generation、publication 或 buildRevision 被跨 tuple 混接；
- pinned artifact load 失败后由 Runtime Plugin 猜测并加载旧 buildRevision；
- external Shell 绕过 concrete host packages，通过 replaceable host/renderer adapter 自行实现 Profile 1；
- Cap’n Web 被用于传输 remote module bytes；
- 为 compiler migration 暴露长期 bundler abstraction。

## 社区基线

- [Manifest and Snapshot](https://module-federation.io/guide/basic/manifest-snapshot)
- [Runtime Plugins](https://module-federation.io/guide/runtime/runtime-plugins)
- [Shared configuration](https://module-federation.io/configure/shared)
- [Share strategy](https://module-federation.io/configure/shareStrategy)
- [Bridge overview](https://module-federation.io/guide/bridge/overview)
- [Vite integration](https://module-federation.io/integrations/build-tool/vite)
