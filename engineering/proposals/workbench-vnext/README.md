# Workbench vNext

> 状态：research proposal。本文档集从零设计一条不兼容的 Workbench vNext，不是当前 API。
> 当前事实仍以 [`../../WORKBENCH.md`](../../WORKBENCH.md)、[`../../FRONTEND.md`](../../FRONTEND.md)
> 和相关领域工程文档为准。

Workbench vNext 是 Pluxel 的 Plugin 微前端平台。它只有一个不可拆分的 closed platform profile，完整包含两条同级核心：

- Module Federation 2.0 负责 producer、remote expose、Manifest/Snapshot、shared dependency 和 Bridge UI lifecycle；
- 每个 browser page 唯一的 Cap’n Web WebSocket session 负责 authentication、Management/Workbench API、
  server push、least-authority capability 和资源回收。

MF 2.0 与 Cap’n Web/WS 都不是 optional implementation。缺少或替换其中任意一条，就不是 vNext 的 degraded mode，而是
unsupported host；但 exact profile 本身是 platform-neutral，任何 framework 的 Shell 都可通过复用 concrete packages 与 conformance
suite 加入。完整 normative boundary 见 [`PLATFORM_CONTRACT.md`](PLATFORM_CONTRACT.md)。Pluxel 在两者之间只补充 Plugin graph
已经拥有、而 MF 与 Cap’n Web 都不应发明的事实：Plugin owner、required
dependency、placement、generation admission、atomic publication 和 withdrawal。

```text
MF 2.0 host/consumer + Plugin producers/remotes/exposes
  + Manifest/Snapshot + Runtime Plugins
  + shared platform + Bridge lifecycle
  + one WS-required Cap'n Web Auth/Control Session
  + one direct Cap'n Web capability per View
  + exact dependency Attachment + least-authority opened View
```

## 如何阅读

`PLATFORM_CONTRACT.md` 优先级最高；其他文档只能细化，不能增加替换自由度。每个领域决策只在一个主题文档中定义。

| 文档                                           | 唯一负责的决策                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| [`PLATFORM_CONTRACT.md`](PLATFORM_CONTRACT.md) | closed Profile 1、fixed choices、portability、versioning 与 conformance   |
| [`AUTHORING.md`](AUTHORING.md)                 | direct ViewApi、常见交互 recipe、View/Attachment 与普通 TS composition    |
| [`EXAMPLES.md`](EXAMPLES.md)                   | 候选 Plugin-facing API 的端到端中性样例                                   |
| [`PUBLICATION.md`](PUBLICATION.md)             | definition/binding/publication、layout、opened View 与 withdrawal         |
| [`CONTROL_PLANE.md`](CONTROL_PLANE.md)         | WS-only Cap’n Web、认证、capability、push、dispose、Vite 与 reverse proxy |
| [`FEDERATION.md`](FEDERATION.md)               | MF producer/expose、Manifest/Snapshot、shared、Bridge、build 与 HMR       |
| [`DELIVERY_PLAN.md`](DELIVERY_PLAN.md)         | 真实样本、package boundary、实施切片、验收、否决条件与未决原型            |

涉及一个完整 View 的执行路径时，阅读顺序是：

```text
PLATFORM_CONTRACT
  fixed Profile 1 choices
       │
       ▼
AUTHORING
  definition + exact binding
       │
       ▼
PUBLICATION
  PublishedTarget -> layout -> opened View
       │                         │
       │                         ├── CONTROL_PLANE: capability/session
       │                         └── FEDERATION: manifest/expose/Bridge
       ▼
DELIVERY_PLAN
  migration gates + acceptance
```

## 不可分割的架构不变量

这些规则横跨全部主题，任何子文档都不能单独放宽：

1. 一个 Plugin node 最多一次原子 `publish()`；普通 TS builder 没有 runtime identity 或 registry。
2. 一个 Workbench page 恰好一个 host-owned session owner，任意时刻最多一条 physical control socket；Remote View 不能创建 root
   stub 或第二条连接。
3. WebSocket 是产品前提。Workbench/Management 平台不保留任何 HTTP batch、SSE route、`EventSource`、polling、transport
   negotiation 或失败 fallback。
4. authentication challenge、session state、logout、Management、layout、ViewApi calls/callbacks/streams 和 lifecycle push
   全部复用同一 Cap’n Web session。
5. Cap’n Web stub 本身就是授权 capability；browser protocol 没有 grant ID、resource namespace lookup 或 resume token。
6. layout 是 by-value description，不携带 callable capability；`openView()` 一次返回 typed API root(s)、server params 与 federation ref，
   不建立中间 resource/session target。
7. Plugin dependency Attachment 只沿 committed direct required edge 绑定，无字符串 registry、候选扫描或 renderer 竞选。
8. MF 2.0 是唯一 browser module system；不再建立 Workbench artifact manifest、plain ESM loader 或 renderer adapter。
9. MF 不承载业务 state，Cap’n Web 不加载 remote module，Plugin graph 不解析 WebSocket payload。
10. disconnect 结束整个 connection epoch；不复活旧 stub、不透明 retry mutation、不 replay transient callback/stream。
11. Bridge 必须先于 opened View handle dispose；socket close 是 server 释放整个 capability graph 的最终幂等边界。
12. Workbench disabled 且 Management 未安装时，不创建 backend、endpoint、producer、compiler、watcher 或 client runtime。
13. Dynamic list/account row 是 API 返回的 domain value，不是 runtime entity；row 数量变化不创建 layout、View、MF
    producer 或 socket。
14. Workbench 只验证 authentication/profile、identity、route/layout/build revision、factory `RpcTarget`、quota 与 lifecycle 等平台协议；
    ViewApi 的领域输入、授权、业务不变量、result/error、operation limit 与兼容策略由 Plugin 自己负责。
15. Renderer API 直接使用上游 `RpcStub<Api>`/`RpcPromise<T>`；sync/async factory 必须在 deadline 内全有或全无，late target 必须回收。
16. Placement 只有 tab/route；navigation group 只是无 lifecycle 的 by-value metadata，route precedence/collision 不依赖注册顺序。

## 总体生命周期

```text
Plugin package build
  local View
    + provider-owned Attachment renderer ──> own MF producer
                                            ├─ mf-manifest.json / Snapshot
                                            ├─ ./views/<view-key> Bridge exposes
                                            └─ shared declarations
  consumer-only Attachment placement ─────> no producer; references provider expose

Plugin generation init
  immutable definition
    + typed ViewApi/Attachment target factories ─> atomic PublishedTarget

Browser page
  initial HTTP document
    └─ one Cap'n Web WS session -------> authenticate -> bootstrap
                                        -> Management/layout/openView
                                        -> direct ViewApi/child stubs

  one Federation Runtime -------------> register manifest on demand
                                        -> loadRemote(expose)
                                        -> Bridge render/update/destroy

Close / withdrawal
  Bridge destroy -> opened View handle dispose -> child capability cleanup
                 -> root dispose/socket close -> server final cleanup
```

HTTP 只保留浏览器原生边界：initial/static document、OIDC redirect/callback、HttpOnly cookie commit、MF
artifact 与真正的文件上传下载。Plugin 业务 HTTP 不受本提案限制。

## 设计来源与替代关系

设计只接受当前真实样本已经证明的抽象：

- Wretch 证明 consumer placement + provider-owned settings Attachment；
- Fonts/Font contribution samples 证明 provider-owned list manager、provider/consumer selection 两种明确 owner 与 dependency
  Attachment 必须分开；
- Telegram/KOOK/Milky/Discord BotManager 证明多页面 topology 应由普通 TypeScript builder 复用，而 runtime owner
  仍属于各平台 Plugin；
- Access、Sandbox、Fonts 和 Bot admin 证明 snapshot/list/action/watch 是常见 ViewApi recipe，但不需要成为 platform resource kinds。

本提案保留 [`../WORKBENCH_PLUGIN_COMPOSITION.md`](../WORKBENCH_PLUGIN_COMPOSITION.md) 中正确的 ownership 证据，但推翻其旧
Contract/Port wiring。原 Portable Workbench 的 replaceable host/loader/renderer 方向已由 exact Profile 1 取代：vNext 保留
cross-framework Shell portability，但不发布可替换 transport/artifact/auth SPI，历史理由由 Git 保留。

## 目标

- 让作者只表达普通 TypeScript API、operation、placement 与 exact dependency，不重复 transport/export/registry wiring；
- 让日常判断固定为 View 或 Attachment、by-value 或 child capability、server API 或 host facade，不暴露更多架构菜单；
- 让 TypeScript 检查 ViewApi/factory/renderer shape，让 runtime 只检查它真正看得见的 owner、key、`RpcTarget`、build 与 lifecycle；
- 让 Cap’n Web method/observer/child target 的 invocation、authority、withdrawal 和 cleanup 有统一语义；
- 让未打开的 View 不创建 capability、subscription、remote registration 或 artifact request；
- 让动态 domain row 增长只改变 bounded ViewApi page values，不扩大 publication、layout、producer、socket 或 per-row capability
  inventory；
- 让 React/UI foundation 通过受控 shared policy 复用，而 Shell private router/store 不泄漏给 remote；
- 让 React/Vue/Svelte/vanilla Shell 复用同一 concrete WS/MF host packages 与同一 built producer；
- 让 Node、Vite 和受支持 reverse proxy 对同一路径、认证、heartbeat、drain 和 close semantics 通过真实 listener 测试；
- 通过一次性切换删除旧 resource-oriented Contract/Extension/Port authoring、HTTP batch/SSE 和 ad-hoc federation wrapper。

## 非目标

- 不把同源 Plugin UI 变成不可信代码 sandbox；独立 origin/iframe/CSP 属于另一套安全设计。
- 不建立任意 UI slot、Feature marketplace、resource registry、priority 或 fallback graph。
- 不建立 collection runtime registry、per-row View/route/capability 或跨 Plugin 字符串引用协议。
- 不在 Cap’n Web 上再建立 Model/Query/Channel protocol，也不用 Workbench 取代 Plugin dependency、database、command registry 或业务 transaction。
- 不强制 Plugin 使用 Valibot、Standard Schema、method descriptor、contract hash、generated validator 或平台统一 domain error。
- 不交付 generic host runtime、bundler adapter、plain ESM mode 或自定义 renderer registry。
- 不支持重新实现 Profile 1 infrastructure 的 alternate Shell；external Shell 必须消费同一 concrete packages 并通过 conformance。
- 不支持 cross-origin Shell、offline mutation、旧 session resume 或长期双栈迁移。
- 不把 OIDC navigation、`Set-Cookie`、静态 artifact 或 file bytes 强行 tunnel 进 Cap’n Web。

## 文档晋升规则

这是实施蓝图，不是 API 权威。每个切片稳定后，必须把已实现事实写回对应领域文档和 `docs/`，并从本目录删除已经完成的
探索性分支。公开 package 发生用户可见变化时，按仓库规则添加 Tegami pending changelog；proposal 的纯重组不创建空 changelog。
