# Pi Agent 插件设计

`@pluxel/pi-agent` 把 Pi 当作 Agent engine，而不是第二个 Pluxel/Cordis 类插件 runtime。

```text
command Plugins -> AgentToolsPlugin -> bound catalog -> PiAgentPlugin -> Pi AgentSession
                                                        |-> goal state
                                                        `-> bounded subagents
```

## 工具和信任边界

- session 创建时选择一个已有 AgentTools assignment；不存在的 setup fail closed；
- descriptor 的 JSON schema 直接成为 Pi tool parameter schema，provider tool name 做确定性安全映射；
- discovery 更新与 tool call 都使用同一个 bound catalog，调用时仍重新检查 assignment；
- cooperative abort signal 进入 `CommandContext.signal`，输出经过 JSON 编码和长度预算；
- Pi built-in tools、extensions、skills、prompt templates、themes 与 AGENTS/context discovery 全部关闭；
- provider credential 仍由 Pi `ModelRuntime` 从标准 Pi credential store 解析，不进入 Plugin config。

## Session、goal 与 subagent

每个公开 session 拥有一个 Pi `AgentSession`、固定 tool setup、可选 goal 和 normalized event stream。会话当前使用
`SessionManager.inMemory()`；因此 API 不声称 resume 或持久化。

Goal 是真实的 session state。模型通过 `pluxel_goal` 读取、设置、完成或清除，调用方也使用同一组 session API。

Subagent 是实际 child `AgentSession`，继承父 session 的 setup、cwd、model、thinking level 和 system prompt。它不能选择
权限更高的 assignment。全局 concurrency gate、depth、每 session 总数和总 session 数共同限制 fan-out；parent dispose
会 abort queued/running children，等待 idle 后再释放所有 upstream resources。完成后的 bounded record 留在 parent snapshot。

## Workbench

Pi Agent 当前不发布 Workbench Definition。未来的 session UI 同时包含 streaming、goal、subagent、abort 与并发状态，属于
完整 Direct View，不拆成 Content。普通 Plugin 配置继续使用标准 Config UI；模型 credential 继续由 Pi `ModelRuntime` 的
credential contract 管理，在 Pluxel 有稳定 Vault-backed 写入契约前不增加平行的 secret form。
