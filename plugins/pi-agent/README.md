# `@pluxel/pi-agent`

Pi Agent 是工作区内的无头模型引擎。它直接使用显式选择的 Command 工具，并提供内存会话、goal 和有界 subagent。它不依赖 AgentTools，也不自动读取 root Commands 目录。

```ts
import { PiAgentPlugin } from '@pluxel/pi-agent'

const agent = host.require(PiAgentPlugin)
await using session = await agent.createSession({ tools: [echo] })
const outcome = await session.prompt('回显 hello')
```

跨 Plugin 发布使用 `agent.expose(command, { context, authorize })`。返回句柄支持 `dispose()` 和 `Symbol.dispose`，并随发布者 generation 自动撤销。`createSession({ tools: ['name'] })` 只选择已有 Pi exposure；字符串不会查询 root Commands。`agent.tools()` 返回此载体的不可变目录，供可信宿主选择。

`principal` 由调用应用认证并作为会话身份传入。应用应传入不可变的身份快照；改变身份须创建新会话。直接 Command 使用会话 `context`，已发布 Command 使用其 exposure 的 `context`，不能被会话覆盖。context factory 每次执行接收 principal、合成 signal 和 deadlineMs，只返回业务扩展字段。signal、deadlineMs 和 meta 由载体填写。`authorize` 在发现和调用时重查；调用时先构造 context，再判定操作权限。

模型只看到本次会话选中且当前获准的工具。工具集合在会话创建时固定；发布撤销或同名替换不会让旧回调复活。每轮 Pi model request 前更新可见列表，每次工具调用再次校验权限。工具调用串行。Plugin 长期资源由 generation effects 管理；会话结束使用 `await session.dispose()` 或 `await using`。

Pi 的内置文件和 shell 工具、项目扩展、skills、模板和 context file discovery 保持关闭。普通 prompt outcome、事件流、goal、subagent、取消和等待退出保持原有契约。工具成功值中的字符串直接成为文本，其他严格 JSON 值成为 JSON 文本；不可编码或超限的值产生 SDK 原生失败，不会重试命令。

本包目前仅供工作区内部使用。[维护约束](DESIGN.md)。
Pi 是可选的 Command 载体；Commands 与 RPC 不依赖 Pi。`createSession()` 接受直接 Command 与显式发布的工具名称。
