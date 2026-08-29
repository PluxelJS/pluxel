# Workbench vNext

> 状态：implementation blueprint，不是当前 API。当前事实仍以
> [`../../WORKBENCH.md`](../../WORKBENCH.md)、[`../../FRONTEND.md`](../../FRONTEND.md)
> 和相关领域工程文档为准。

Workbench vNext 是一个 closed platform profile：Module Federation 2.0 负责浏览器模块交付与
renderer lifecycle，Cap’n Web over WebSocket 负责认证、Management/Workbench API、push 与
capability lifecycle，Pluxel Plugin graph 负责 owner、required dependency、generation 与原子发布。

这三部分解决不同问题，且都属于 contract：

- MF2 使独立构建的 Plugin UI 能被同一 Shell 按需加载并安全复用 platform shared；
- 单一 Cap’n Web WebSocket 使认证、调用、callback、撤销和断线共享同一个 connection epoch；
- Plugin graph 使跨 Plugin UI 沿已提交的 required dependency 确定绑定，不再建立第二套发现系统。

Workbench 作者面冻结为：

```text
View<Api>
Attachment<ProviderApi, ConsumerApi = never>
workbench.define({ ...entries })
ctx.workbench?.publish(definition, { ...bindings })
useWorkbench(exactDescriptor)
```

`View` 表示当前 Plugin 拥有的 renderer、placement 与一个 API root。`Attachment` 表示 required
provider 拥有 renderer/provider API、consumer 拥有 placement，并可选提供一个 consumer API root。
其他交互直接使用普通 Cap’n Web method、callback、stream、child capability 和 by-value domain data。

## 文档职责

| 文档                                                       | 内容                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------ |
| [`PLATFORM_CONTRACT.md`](PLATFORM_CONTRACT.md)             | Profile 1 的固定选择、portability、versioning 与 conformance |
| [`AUTHORING.md`](AUTHORING.md)                             | Plugin-facing API、判断规则、host facade 与数据形态          |
| [`PUBLICATION.md`](PUBLICATION.md)                         | definition、binding、publication、open 与 withdrawal         |
| [`CONTROL_PLANE.md`](CONTROL_PLANE.md)                     | WS、认证、capability、push、断线、Vite 与 reverse proxy      |
| [`FEDERATION.md`](FEDERATION.md)                           | producer、Manifest/Snapshot、shared、Bridge 与 revision      |
| [`EXAMPLES.md`](EXAMPLES.md)                               | 最小 View、document、task/file、Attachment 与 BotManager     |
| [`FONT_COLLECTION_EXAMPLE.md`](FONT_COLLECTION_EXAMPLE.md) | FontManager collection 的完整 ownership 与调用链             |
| [`DELIVERY_PLAN.md`](DELIVERY_PLAN.md)                     | package boundary、迁移切片、保留资产与验收 gate              |

实现者先读 `PLATFORM_CONTRACT.md`，再按工作范围阅读对应主题。本文只给出全局不变量，
主题文档负责可执行细节。

## 架构不变量

1. Profile 1 固定使用 MF2、React Bridge 和 Cap’n Web over WebSocket；不提供 transport、loader、
   renderer 或 auth SPI。
2. 每个 browser page 恰好一个 host-owned Cap’n Web session 和一个 MF Runtime；Remote View
   不创建第二条 control socket、session root 或 MF instance。
3. Authentication、Management、Workbench calls、callbacks、streams 与 lifecycle push 走同一
   WebSocket。平台没有 HTTP batch、SSE、polling、resume 或 fallback。
4. HTTP 只保留浏览器硬边界：initial/static document、OIDC redirect/callback、HttpOnly cookie
   commit、MF artifacts 与真实文件传输。Plugin 自己的业务 HTTP 不受限制。
5. `openView()` 一次返回 direct API root(s)、server-derived params 与 federation reference；
   layout 不携带 capability，也不存在 resource/grant/session 二次 lookup。
6. 一个 Plugin generation 最多提交一次 flat、exact、atomic publication。Attachment 只能绑定
   committed direct required dependency，不扫描 provider 或协商候选。
7. View/provider descriptor identity 只由 owner definition address、entry key 与 kind 组成；placed
   Attachment 再加入 consumer entry 与 exact provider identity。Declaration identity 在
   server/producer/wrapper 一致，consumer lowering 组合完整 placement；不依赖 object identity、source
   path 或 bundler hash。
8. Definition/publication topology 在 generation 内静态；没有条件 entry、动态 visibility predicate、
   append/remove 或第二次 publish。
9. Workbench 只验证 profile、identity、route/layout/build、factory target、quota 与 lifecycle。
   Plugin 自己负责 domain validation、authorization、result/error、容量和兼容策略。
10. Collection、account、row、query result 都是 Plugin domain data。它们的数量不会创建 View、
    route、publication、Bridge、MF expose、socket 或默认 child capability。
11. 每个 API capability interface 扩展 pinned `RpcTarget`；target 声明自然同步/异步返回类型，
    `RpcStub<Api>` 自动推导 client result。Object result 与 child stub 遵守 Cap’n Web 显式 disposal；
    Subscription 不重复声明 `close()` RPC。
12. Renderer 是零 props component，通过 descriptor-bound `useWorkbench()` 取得上游
    `RpcStub<Api>` 与固定 host facade。Bridge props 和 Provider 仅存在于生成的内部 wrapper。
13. View 激活单位是 generation + publication + descriptor + buildRevision + roots + Bridge；旧新 tuple
    不能混接。Dev renderer candidate 成功后也整页重载，不做页内 Bridge/root swap。
14. View 未打开时不调用 target factory、不订阅、不注册 remote、不请求 artifact。关闭时先
    destroy Bridge，再 dispose opened handle；socket close 最终释放整个 capability graph。
15. Disconnect 结束整个 document epoch。Shell 销毁全部 UI/roots；每个 history entry 最多自动整页
    重载一次，重复失败停在硬失败页。同一 page 不创建第二条 session，也不恢复旧
    stub/callback/stream/mutation。
16. Workbench disabled 且 Management 未安装时，endpoint、auth backend、producer、compiler、
    watcher 和 browser runtime 的分配必须为零。

## 生命周期

```text
build
  workbench.define(entries)
    -> Vite + MF2 producer
    -> mf-manifest.json / Snapshot
    -> one React Bridge expose per View/Attachment renderer

Plugin generation init
  definition + exact factories/dependencies
    -> ctx.workbench.publish(...)
    -> atomic PublishedTarget + capability-free layout

browser page
  initial document
    -> one control WS session -> authenticate -> bootstrap -> layout/openView
    -> one MF Runtime -> register manifest -> load expose -> Bridge render
    -> renderer useWorkbench(descriptor) -> direct root(s) + host facade

close or withdrawal
  Bridge destroy
    -> host document/transfer cleanup
    -> remote child/object-result cleanup -> opened handle cleanup
    -> owner withdrawal or socket close performs final bounded cleanup
```

## 设计边界

Profile 1 保留业务扩展能力，但关闭平台骨架扩展点。Plugin 可以自由设计 RPC methods、领域
result、parser、task、stream、业务 HTTP 与 UI 组件；不能扩展 connection topology、artifact
protocol、share policy、renderer ABI、publication registry 或 reconnect policy。

以下概念不进入 Workbench contract：

- Model、Query、Channel、Collection、Feature、Port、grant 或 resource namespace；
- global collection/account registry、per-row View/capability 和字符串 provider reference；
- public Bridge props、generic host state、raw Shell router/store、raw WebSocket 或 MF Runtime；
- plain ESM/local-component fallback、multiple transport profile 与长期双栈迁移；
- Workbench 强制的 Valibot/Standard Schema/method descriptor/contract hash。

平台中立的含义是：React、Vue、Svelte 或 vanilla Shell 都能复用同一 concrete host packages、
同一 built producer 和同一 conformance suite。它不表示每个 Shell 可以重写 transport、MF host
或 lifecycle。

## 晋升规则

本目录只保留重构理由、最终 contract、实施约束和未完成 gate。切片稳定后，已实现事实必须写回
对应工程文档与 `docs/`；历史方案与讨论由 Git 保存。公开 package 出现用户可见变化时按仓库规则
添加 Tegami pending changelog，proposal-only 文档调整不创建空 changelog。
