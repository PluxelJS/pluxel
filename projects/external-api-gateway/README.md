# External API Gateway

独立的 `runtime-static` 项目，用 Pluxel 插件系统接入外部 API，并通过稳定 gateway tool surface 给外部程序和 agent 使用。

## Docs

- 外部接入和调用示例：[docs/USAGE.md](docs/USAGE.md)
- 接口设计、Cap'n Web 约定和 provider 边界：[docs/DESIGN.md](docs/DESIGN.md)

## Commands

```bash
pnpm --filter @repo/project-external-api-gateway dev
pnpm --filter @repo/project-external-api-gateway static
pnpm --filter @repo/project-external-api-gateway verify
```

默认端口：`3313`。

默认开发 token：

```text
dev-zhipu-token-change-me
```

External gateway RPC:

```text
http://127.0.0.1:3313/__pluxel/plugins/ExternalGatewayPlugin/gateway/rpc
```

当前插件：

- `ExternalGatewayPlugin`：外部 Cap'n Web RPC 入口，负责 `apiToken -> AuthedApi`、token 吊销、tool specs 和 tool dispatch。
- `UsageBillingPlugin`：上游用量/计费插件，按 `userId + provider + operation + model` 汇总调用、延迟、输入输出体积、单位用量和成本。
- `ZhipuProviderPlugin`：智谱 OpenAPI provider，依赖 shared usage recorder，保存 API Key，并为 gateway tools / 插件 UI 提供 OCR、文件解析、搜索、模型、embedding、rerank 等内部调用能力。
- `YiqichaProviderPlugin`：亿企查 provider，保存凭据、维护 API catalog，并通过少量 gateway tools 暴露企业数据能力。
