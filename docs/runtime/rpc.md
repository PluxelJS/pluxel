---
title: RPC Command catalog
description: 显式发布构建制品中的 Command，并按精确契约创建会话。
---

`@pluxel/services/rpc` 是可选的 Command 载体。Host 在服务清单中显式加入 `rpc()`；默认清单不会安装它。该服务只登记 Plugin 明确发布的 Command，不镜像 root Commands 目录，也不创建 HTTP 监听器或代码执行沙盒。

```ts no-twoslash
import { rpc } from '@pluxel/services/rpc'

const services = [rpc()]
// 将 services 放入 Host 应用声明。
```

## Plugin 发布

在经过 Pluxel Vite/Rolldown 工具链处理的 Plugin 源码中，直接写静态 `publish()` 调用。`commands` 的值须是可解析的直接 Command 引用；发行包要携带这些 Command 的 TypeScript 源码。工具链在类型擦除前生成方法允许表与完整客户端声明，运行时核对实际 Command 对象和构建制品。

```ts no-twoslash
import { BasePlugin, Plugin } from '@pluxel/core'
import { Rpc } from '@pluxel/services/rpc'
import { readNote } from '@acme/notes-commands'

@Plugin()
export class NotesPlugin extends BasePlugin {
	protected override init() {
		this.ctx.require(Rpc).publish({
			id: 'notes',
			commands: { read: readNote },
			context: ({ principal }) => ({ actorId: requireActorId(principal) }),
			authorize: ({ principal, name }) => name === 'notes.read' && canReadNotes(principal),
		})
	}
}
```

`context` 每次调用构造可信业务字段，不能覆盖 `signal`、`deadlineMs` 或 `meta`；Command 要求必需业务字段时，发布必须提供 factory。`authorize` 在发现和调用时重新检查当前权限。输入中的具体资源仍由 Command 或领域服务授权。每个 API id 只能有一个当前发布；`dispose()` / `Symbol.dispose` 同步撤销后续调用，Plugin 停止会撤销并等待已接纳工作退出。

当前构建入口只接纳静态方法表、可解析的 Command 引用以及可打印成 JSON DTO 的成功类型。成功值中有意声明的 `unknown` 会保留给调用方缩小，运行时仍校验 JSON；`true` 与 `false` 字面量会保留在客户端类型和授权契约中。输入中的 `unknown`、任何 `any` 以及 class 实例成功值均在构建时拒绝。无法解析的跨包类型、动态方法表和不支持的 schema 会在构建时明确失败。

静态 Command 输入可使用 `obj()`、`openObj()`、`Type.Object()`、`Type.Array()`、`Type.String()`、`Type.Integer()`、`Type.Number()`、`Type.Boolean()` 和字段 `Type.Optional()`；嵌套对象默认封闭。字段 `Type.Transform()` 只发布其内层 wire schema。常见长度、数值、数组和对象约束，以及静态 JSON `default`、`examples` 会进入制品；描述和标题只在 schema 位置从授权 hash 中剥离。动态 schema 表达式和未支持的 TypeBox 构造会在构建时拒绝。

## 可信应用创建会话

应用在认证后，从 root 服务创建会话，并传入已批准的精确 `{ id, hash }` 契约。`publication.contract` 可用于取得当前契约，但持有它本身不授予权限；应用策略必须保存并核对获准 hash，不能按 id 自动选择最新 hash。
`principal` 应是本次会话的已认证、不可变身份快照。RPC 保留应用传入的身份对象；共享对象内容改变会影响后续授权判定。切换身份时创建新会话，实时权限变化仍由 `authorize` 查询应用策略。

```ts no-twoslash
const rpcService = host.ctx.require(Rpc)
await using session = rpcService.createSession({
	principal: authenticatedUser,
	access: approvedContracts,
})

const matches = await session.search({ query: '笔记', limit: 5 })
const descriptions = await session.describe({ apis: ['notes'] })
const result = await session.call({ id: 'notes', method: 'read', input: { id: 'one' } })
if (result.ok) console.log(result.value)
else console.error(result.error.code, result.error.outcome)
```

会话固定创建时的 publication generation；撤销、替换或 `session.revoke(['notes'])` 后旧会话不会跟随新发布。`search()` 和 `describe()` 只显示当前获准且通过 `authorize` 的操作；同一 API 中被拒绝的方法不会出现在摘要、schema 或客户端声明中，全部方法被拒绝时隐藏该 API。`authorize` 意外抛错会使本次发现失败，不交付部分列表。会话关闭拒绝新调用、取消并等待已接纳工作退出。`RpcResult` 是普通 JSON DTO，成功值在 `value`，失败在 `error`；失败只交付安全字段、`callId` 和 `outcome`。`outcome: 'unknown'` 表示不能据此判断业务是否提交，写入应以领域回执或已有操作 ID 核实。

服务内核不提供宿主认证或持久策略存储。HTTP carrier 与隔离 TypeScript executor 仍在内部集成验证中，尚无稳定公开安装入口。
