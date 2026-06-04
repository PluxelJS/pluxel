# Ops

Runtime control-plane 使用 operation 模型。目标是让 CLI、RPC、MCP、workbench 投影同一套语义，而不是各自发明插件控制 API。

## 设计原则

- 一个 op registry 是 canonical control boundary。
- op descriptor 带 `id`、`doc`、input schema、output schema。
- adapter visibility 属于 runtime/adapter metadata，不写进 core descriptor。
- 内部调用默认也不绕过输入/输出校验。
- `opsCatalog()` 返回 read model，不暴露内部 registry object。
- MCP tool 帮助信息来自 op `doc` 和 schema，不在 carrier 拼第二份文案。
- 插件自定义 op 使用插件自有前缀，不复用 runtime canonical namespace。

## 当前 canonical plugin/config ops

当前 runtime 已收敛到这一类 op：

- plugin list/status/start/stop/restart/enable/disable。
- plugin wait-for-stage。
- dependency list/inspect/set-target。
- base provider inspect/select。
- fork ensure。
- plugin schema。
- plugin config get/validate/patch/reset。
- bulk plugins config/status operations。

security 管理不进入 runtime ops，浏览器宿主管理面走 `/security` 和专用 security client。

## 投影关系

```text
OpsService registry
-> HTTP/RPC catalog + invoke
-> MCP tools
-> CLI commands
-> workbench actions
```

如果新增控制能力，优先新增/调整 op，再让各 carrier 投影它。不要在某个 carrier 内私下实现另一套等价语义。

## 实现入口

- `packages/runtime/src/services/ops/OpsService.ts`：runtime ops registry。
- `packages/runtime/src/api/ops/**`：operation implementations。
- `packages/runtime/src/api/http/**`：HTTP/internal API handlers。
- `packages/runtime/src/api/mcp/**`：MCP projection。
- `packages/runtime/src/web/**`：browser clients。
- `packages/cli/src/commands/**`：CLI command projection。

## 未来方向

Ops V2 仍是提案：轻量 descriptor、doc/schema 必填、adapter metadata 外置、read model 和 registry internals 分离。这些原则已经影响当前实现，但未实现的 V2 设计仍以 `proposals/README.md` 为准。
