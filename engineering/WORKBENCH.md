# Workbench 架构

Workbench 是 host-owned 的插件管理界面。它只投影已经存在的 Plugin 状态和操作，不成为业务能力、
领域状态或 Plugin dependency 的替代品。一个 Workbench-enabled host 固定使用三项基础设施：

- Cap’n Web over WebSocket 承载认证、Management、View API 和双向通知；
- Module Federation 2.0 Manifest/Snapshot 交付浏览器模块；
- React Bridge 管理每次 View 打开对应的 render/destroy 生命周期。

这三项是同一个实现契约，不提供可替换 transport、loader 或 renderer SPI。Workbench 可以在 headless
部署中整体不安装；一旦安装，就不存在缺少 WebSocket、MF2 或 Bridge 时仍部分工作的模式。

## 平台边界

Workbench 只定义四个作者概念：

| 概念       | 作用                                                    | 所有者                                    |
| ---------- | ------------------------------------------------------- | ----------------------------------------- |
| Definition | 一组固定的 View、Attachment 和 placement                | Plugin definition                         |
| View       | Plugin 自己放置、自己提供 API 和界面的页面              | 发布它的 Plugin                           |
| Attachment | provider 提供界面和 provider API，consumer 决定是否放置 | provider declaration + consumer placement |
| Placement  | `tab()` 或 `route()` 的产品位置                         | View owner 或 Attachment consumer         |

Workbench 不定义数据库查询模型、领域事件模型、集合注册表、动态 feature registry 或通用 schema 层。
页面需要什么交互，Plugin 就公开一个直接的 `RpcTarget` 接口。分页、snapshot、watch、任务、冲突码和
输入校验都是该 Plugin 的领域 API，由 Plugin 按真实需求实现。

`collection`、bot account、font family、document row 等始终是 Plugin 领域对象。它们可以由一个 manager
View 管理，也可以由 Attachment 选择，但不会因数量变化而创建 Workbench entry、MF producer、socket 或
平台 identity。

业务代码必须在 Workbench disabled 时仍能运行。跨 Plugin 的服务端协作继续使用 constructor dependency；
Attachment 只复用 provider 的界面，不建立新的业务依赖机制。

## 公开作者面

```ts
workbench.define({ ... })
workbench.view<Api>({ renderer, placement })
workbench.attachment<ProviderApi, ConsumerApi?>({ renderer })
attachment.place(placement)
workbench.entry(import.meta.url, './ui.tsx')
workbench.tab({ ... })
workbench.route('/path/:param', { ... })
ctx.workbench?.publish(definition, bindings)
useWorkbench(exactDescriptor)
useRemoteValue({ read, subscribe? })
```

入口职责固定为：

- `@pluxel/runtime/workbench`：browser-safe definition builder 和类型；
- `@pluxel/runtime/workbench/react`：零 props renderer 的 hook、host facade 和 Pane Kit；
- `@pluxel/runtime/workbench/client`：conforming Shell 使用的 session/opened-handle client；
- `@pluxel/runtime/capnweb`：固定版本的 `RpcTarget`、`RpcStub` 和 WebSocket session bridge。

Plugin author 不取得 raw socket、MF Runtime、Shell router/store、Bridge wrapper props 或 server registry。
Toolchain 生成的 Bridge wrapper ABI 固定在 `@pluxel/runtime/internal/workbench-react`；它与其他 internal readers
只供构建器和 Shell 使用，不进入作者 API。

## Definition 与源码组织

一个有 UI 的 Plugin 通常使用三类文件：

```text
src/workbench.ts       browser-safe API、DTO 和固定 definition
src/index.ts           Plugin、领域实现、RpcTarget 和 publish()
src/ui/*.tsx           零 props React renderer
```

`workbench.ts` 可以从 package 的 `./workbench` subpath 导出，供依赖者引用 Attachment descriptor。它不能
导入 Plugin instance、Context、database handle、Node builtin 或 secret。`workbench.entry()` 的第二个参数必须
是 module-relative literal；它只是 toolchain 可追踪的源码 provenance，不是运行时 dynamic import。

Definition 是 flat、frozen、固定键集合：

```ts
export const OrdersWorkbench = workbench.define({
	manager: workbench.view<OrdersApi>({
		renderer: workbench.entry(import.meta.url, './ui/manager.tsx'),
		placement: workbench.route('/orders', {
			title: 'Orders',
			navigation: { label: 'Orders' },
		}),
	}),
})
```

Entry key 与 owning `PluginDefinitionAddress` 构成 declaration identity。Attachment placement 还包含 consumer
definition 和 provider Attachment identity。源码路径、class name、`displayName`、MF remote name 和数组顺序都不参与
这项 identity。

Definition 只声明固定拓扑。运行期 item 可见性、权限和业务状态进入 `RpcTarget` 返回值；不得通过动态增删 entries、
按 principal 生成 definition 或每个 item 发布一个 View 表达。

## Publication 与 target 生命周期

Plugin 在 `init()` 中最多发布一次，bindings 的键必须与 definition 完全一致：

```ts
this.ctx.workbench?.publish(OrdersWorkbench, {
	manager: ({ principal, params, signal }) =>
		new OrdersTarget(this.orders.authorizedFor(principal), { params, signal }),
})
```

`publish()` 从当前 Plugin Context 推导 owner，并把 publication 绑定到 generation effects。`PluginPart` 不能直接
发布；owning Plugin 聚合 Part 需要的 entries。Publication 只有在 owner generation committed/running 时进入 layout，
stop、replacement、rollback 或 shutdown 都沿同一 effects 路径撤销。

Factory 只在用户实际打开页面时运行，并且每次打开都返回 fresh `RpcTarget`。Open context 由平台构造：

- `principal` 来自当前已认证 socket epoch；
- `params` 由 server 对 declared route 重新匹配并冻结；
- `signal` 在 View close、socket close、owner withdrawal 或超时时 abort。

Factory 不取得 raw request、auth provider、consumer Context 或 service locator。`RpcTarget` 可以引用 Plugin 已有的
领域 service，但 target 自己的 observer、subscription、task 和缓存必须随 `signal` 或 target disposer 清理。

Workbench 不要求 API 另外声明方法 schema。TypeScript interface 约束调用面，Cap’n Web 负责对象图和 capability
传输；Plugin 仍负责它真正需要的输入预算、领域授权和稳定失败码。内部管理页并不等于可信调用方。

## View

View 同时拥有 renderer、placement 和一个 API root：

```ts
export interface OrdersApi extends RpcTarget {
	snapshot(): OrdersSnapshot
	refresh(): Promise<OrdersSnapshot>
	watch(invalidate: () => void): RpcTarget
}

export const OrdersWorkbench = workbench.define({
	overview: workbench.view<OrdersApi>({
		renderer: workbench.entry(import.meta.url, './ui/overview.tsx'),
		placement: workbench.tab({ label: 'Orders' }),
	}),
})
```

Renderer 是零 props component，并用 declaration 中的 exact descriptor 取得 API：

```tsx
export default function OrdersOverview() {
	const { api, host } = useWorkbench(OrdersWorkbench.overview)
	const orders = useRemoteValue({
		read: () => api.snapshot(),
		subscribe: (invalidate) => api.watch(invalidate),
	})
	// ...
}
```

Descriptor 同时完成 TypeScript 推导和运行时 identity 校验。`useWorkbench()` 不接受字符串 key，也没有可枚举的
全局 API namespace。UI helper 可在 Plugin package 内围绕 direct API 组合 read model，但不会升级成平台 primitive。

参数化 route 只声明一次：

```ts
account: workbench.view<AccountApi>({
	renderer: workbench.entry(import.meta.url, './ui/account.tsx'),
	placement: workbench.route('/accounts/:accountId', { title: 'Account' }),
})
```

一个 manager 可以调用 `host.navigation?.openDocument()` 打开不同 `accountId`。所有 account 共用同一个 descriptor、
Bridge expose 和 producer；每个实际打开的 document 才获得独立 API root 和 abort signal。

## Attachment

Attachment 解决唯一一种跨 Plugin UI 组合：provider 拥有界面，consumer 决定把它放在哪里。它不自动投影
provider 的其他 View，也不扫描 dependency graph 寻找任意 renderer。

Provider 声明并发布：

```ts
export const HttpWorkbench = workbench.define({
	settings: workbench.attachment<HttpSettingsApi>({
		renderer: workbench.entry(import.meta.url, './ui/settings.tsx'),
	}),
})

this.ctx.workbench?.publish(HttpWorkbench, {
	settings: ({ consumer, signal }) =>
		new HttpSettingsTarget(this.settings.forConsumer(consumer.node), signal),
})
```

Consumer 通过正常 constructor dependency 取得 provider，并放置 Attachment：

```ts
export const ReportsWorkbench = workbench.define({
	http: HttpWorkbench.settings.place(workbench.tab({ label: 'HTTP' })),
})

this.ctx.workbench?.publish(ReportsWorkbench, {
	http: { provider: this.http },
})
```

Renderer 调用 `useWorkbench(HttpWorkbench.settings)` 得到 `{ provider, host }`。Provider factory 只获得 exact
consumer node address，用它索引 provider 自己已经拥有的 per-consumer state；它不能取得 consumer instance 或 Context。

如果 consumer 也拥有必须由这个界面修改的状态，Attachment 声明第二个 API generic：

```ts
workbench.attachment<CatalogApi, SelectionApi>({ renderer })
```

Placement binding 再提供 `consumer: () => new SelectionTarget(...)`，renderer 得到
`{ provider, consumer, host }`。两个 roots 分别保留自己的 owner、授权和清理路径，不能互相转发成一个万能 facade。

## Manager、collection 与 bot 场景

FontManager 类需求采用稳定 topology：

- manager View 管理字体、collection、分页和 CRUD；
- provider API 返回 catalog/snapshot，并提供需要的 watch；
- consumer 只持久化 stable collection ID 和自己的 fallback policy；
- picker Attachment 同时读取 provider catalog 与 consumer selection；
- 服务端渲染仍直接调用 constructor-injected FontManager dependency。

创建、改名或删除 collection 只改变 FontManager domain state。删除后 consumer 保存的 ID 可以投影为 `missing`，
由 consumer 决定保留、清除还是 fallback；provider 不越权批量改写 consumers。只有产品确实需要多个并行独立
editor 时，才增加一个 parameterized View，仍不为每个 collection 建 entry。

BotManager 同理：一个平台 Plugin 可以声明 overview、accounts、diagnostics 和可选 account document。Telegram、KOOK、
Discord 等平台只在确实共享普通 TypeScript builder 时复用 declaration 生成函数；它们继续拥有独立 Plugin lifecycle、
persistence、factories 和 failure boundary。Bot account 是 row，不是 Plugin 或 Workbench identity。

更完整的作者样例见 [`../docs/workbench/composition.md`](../docs/workbench/composition.md)。

## 页面唯一的 Cap’n Web session

Workbench document 创建一个物理 WebSocket：

```text
/__pluxel/runtime/session
```

同一 socket 上的 bootstrap 状态是封闭联合：

1. 未认证时只返回 authentication capability；
2. password、TOTP 或 OIDC challenge 在同一 Cap’n Web object graph 中完成；
3. 认证完成后再次 bootstrap，得到 Management capability；Workbench-enabled host 同时返回 Workbench session；
4. layout、openView、Management mutation、logs follow 和 Plugin API 都复用这条 socket。

浏览器写入 `HttpOnly` cookie 需要一个 same-origin、single-use cookie-commit POST；它只提交短期 ticket，不承载
业务 API 或 RPC。MF manifest 和 JS/CSS 使用普通 HTTP。除此之外，Workbench 不建立另一种 API transport。

一个 document 不做 feature reconnect。认证 authority、publication inventory 或 socket epoch 失效时，server 先发送
`epoch-invalidated`，随后关闭物理连接；Shell 销毁 active Bridges、释放 opened handles，并要求完整 document reload。
同一 document 不创建第二条 session，不重建部分 roots，也不恢复旧 workspace 上的 remote instance。

Node production 与 static/dynamic Vite 使用同一个 runtime carrier seam。Vite 保留 listener 和 HMR Upgrade 优先权，
Runtime 只接管匹配的 control/business Upgrade。反向代理必须保持同源 cookie、WebSocket Upgrade 和短期 handoff 的
实例归属；Runtime 不从 forwarding headers 推导 physical TLS 或 locality。

## Layout 与打开流程

`WorkbenchSessionApi` 只有两个操作：

```ts
layout({ target })
openView({ layoutRevision, target, descriptor, location? })
```

Layout 是 capability-free 的 immutable snapshot，只包含目标、placement、declaration/openable identity、owner revisions
和固定的 federated view reference。它不携带 Plugin API root 或可遍历的服务字典。

打开流程固定为：

1. Shell 从当前 layout 选择 entry；
2. `openView()` 校验 revision、target、descriptor 和 route，并创建 owner invocation lease；
3. local View 返回一个 fresh API root；Attachment 返回 provider root，并按声明可选返回 consumer root；
4. Shell 通过 pinned manifest/expose 加载并校验 Bridge；
5. Shell 创建 per-open host facade，render Bridge；
6. close 时先 destroy Bridge，再关闭 host facade，最后 dispose opened handle。

任一步失败都释放 candidate roots，不发布半激活 View。每个 session 最多 64 个 opened Views，factory 默认 15 秒
超时。Layout revision 改变、target 不可用和 quota/factory failure 使用封闭 code 返回；编程或 transport failure 继续 reject。

## MF2 交付与 React Bridge

Toolchain 在 TypeScript 擦除前读取 `workbench.define()` 和 literal `workbench.entry()`，把同一 Plugin definition
的所有 View/Attachment renderer 合并为一个 producer。每个 declaration 生成一个稳定 `./views/<key>` expose 和
一个 Bridge wrapper。作者不手写 remote name、expose、shared、public path 或 manifest URL。

生产产物以 `mf-manifest.json` 为唯一浏览器模块事实；Snapshot 由标准 Manifest 生成。Host 只保存
`Plugin definition + build revision -> immutable artifact root/manifest URL` 的冻结 inventory，不复制 Manifest 的 assets、shared
或 types 字段。Manifest、remote entry、expose inventory、dynamic types 和 shared versions 必须全部验证后才能提交。
提交时 Host 对 producer root 的全部 regular files 建立 digest inventory，并只服务这份冻结集合；Manifest 的 assets
字段不是 remote entry 内部 import closure 的完整文件清单，不能被误作 HTTP 白名单，也不需要解析生成的 JavaScript 补全。

固定 singleton shared 包括：

- `react`、`react/jsx-runtime`、`react/jsx-dev-runtime`；
- `react-dom`、`react-dom/client`；
- `@mantine/core`、`@mantine/hooks`；
- `@module-federation/bridge-react`；
- `@pluxel/runtime/workbench`、`/client`、`/react`。
- `@pluxel/runtime/internal/workbench-react`。

版本必须精确匹配并使用 `loaded-first`。Shell 先建立 winner，再按需注册 remote；不接受第二份 React 或 Mantine，
也不允许 Plugin 局部覆盖 share policy。Producer 对固定 shared 使用 `import: false`，不携带 fallback。Router、编辑器和
领域 library 等未进入固定 profile 的依赖继续由 producer 自己 bundle。

Bridge wrapper 是 toolchain 生成的内部 ABI。它把 opened handle 与 host facade 放进每个 Bridge instance 独立的
React Context，然后调用零 props renderer。Remote 不读取官方 Shell private Context。Bridge destroy 是释放 portal、effect、
subscription 和 document chrome 的唯一 UI lifecycle 边界。

每个 Bridge application 是独立 React root，因此 UI library 的 Context 不能从 Shell 跨 root 继承。Mantine renderer 必须在
自己的 renderer root 内创建 `MantineProvider`，但 Provider 和全部 Mantine component/hook 实现来自 Shell 提供的 singleton
shared module；`@mantine/core` 基础 CSS 同样只由 Shell 加载，producer build 会拒绝重复导入。Router、i18n 或其他 Context
library 仍由 producer 自己拥有 Provider、module 和 CSS。Remote 可以从 `host.locale`、`host.colorScheme` 等固定 portable fact
初始化或同步表现，但不能读取 Shell 的私有 Provider 或 theme object。共享 module instance 不会改变 React Context 的祖先边界。

开发期 renderer 变化先构建并验证新的完整 producer candidate。失败不改变当前 inventory；成功提交后触发整页 reload。
不做页内 remote replacement，不把新 roots 接到旧 Bridge，也不在加载失败时尝试其他 build revision。

## Host facade 与 Pane Kit

`useWorkbench()` 返回的 `host` 只包含固定行为：

- `locale`、`colorScheme`；
- `notify()`、`confirm()`；
- 可空的 relative `navigation`；
- 参数化 document 的 params、dirty marker 和 title；

Remote 不取得 generic HTTP client、raw socket、Shell store 或 unrestricted URL navigation。复杂页面可以使用
`WorkbenchPaneLayout` / `WorkbenchPane` 声明 navigation、primary、inspector 三栏；宿主拥有 resize、drawer、focus
和 workspace persistence。

## 资源所有权与清理

下列事件会使整个 socket epoch 或对应 opened handle 失效：

- authentication/logout/revoke；
- Plugin owner 或 Attachment provider stop/replacement；
- publication 或部署 producer inventory 改变；
- physical WebSocket broken；
- View close 或 Bridge activation failure。

Owner withdrawal 先关闭 invocation admission、abort open signal，再等待已接纳调用并 drain generation effects。
Opened handle 对 Cap’n Web 返回的顶层 object graph 负责；renderer 若手工 await object result，应先复制需要长期保留的
DTO，再 dispose transport result。Observer/callback 需要跨调用保留时必须 `dup()`，subscription target 的 disposer 负责
释放 callback 和领域 unsubscribe。

## 验证不变量

实现或修改 Workbench 时至少验证：

- 一个 document 只有一个 physical session 和一个 MF Runtime；
- auth challenge、ready bootstrap、Management、View API 和 logs follow 使用同一 socket；
- definition/bindings exact，descriptor identity 不可伪造；
- 每次 open 都返回 fresh roots，close/timeout/replacement 会 abort 并清理；
- provider-only 与 provider+consumer Attachment 都保持正确 owner；
- Manifest/expose/shared/Bridge 不匹配会在 commit 或 activation 前失败；
- Bridge destroy 发生在 opened handle dispose 之前；
- dev candidate 失败保留当前 revision，成功后完整 reload；
- dynamic rows 数量不改变 definition、producer 或 socket 数；
- headless host 不初始化 Workbench backend，但 Plugin 业务能力仍正常。

## 实现入口

- `packages/runtime/src/workbench/definition.ts`
- `packages/runtime/src/workbench/client-protocol.ts`
- `packages/runtime/src/workbench/client.ts`
- `packages/runtime/src/workbench/react.tsx`
- `packages/runtime/src/workbench/react-internal.tsx`
- `packages/runtime/src/workbench/federation.ts`
- `packages/runtime/src/services/workbench/WorkbenchRegistry.ts`
- `packages/runtime/src/services/workbench/WorkbenchSessionTarget.ts`
- `packages/runtime/src/web/session/`
- `packages/rolldown/src/workbench/semantic-lowering.ts`
- `packages/rolldown/src/vite/workbench-ui.ts`
- `packages/workbench-app/src/workbench/`
