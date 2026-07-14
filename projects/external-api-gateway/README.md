# External API Gateway

独立的 `runtime-static` 项目，用 Pluxel 插件系统接入外部 API，并通过稳定 gateway tool surface 给外部程序和 agent 使用。

## Docs

- 外部接入和调用示例：[docs/USAGE.md](docs/USAGE.md)
- 接口设计、Cap'n Web 约定和 provider 边界：[docs/DESIGN.md](docs/DESIGN.md)

## Commands

```bash
pnpm --filter @repo/project-external-api-gateway dev
pnpm --filter @repo/project-external-api-gateway static
pnpm --filter @repo/project-external-api-gateway headless
pnpm --filter @repo/project-external-api-gateway verify
```

`headless` 关闭整个 Workbench Plane bundle；外部 gateway、provider HTTP 和计费能力仍然启动。
这条入口用于持续验证管理 UI 只是业务状态的可选投影。

`pnpm test:headless` 会使用临时数据目录和随机端口启动同一路线，请求 gateway/provider
业务接口后关闭宿主；`verify` 已包含这项集成验证。

默认端口：`3313`。`dev` 和 `static` 都运行 Vite + runtime-static host，并把 `/external-gateway/*` 代理到 Pluxel runtime HTTP router；插件源码始终经过 Pluxel Vite/Rolldown 转换链。

默认开发 token：

```text
dev-zhipu-token-change-me
```

External gateway RPC:

```text
http://127.0.0.1:3313/external-gateway/rpc
```

当前插件：

- `ExternalGatewayPlugin`：外部 Cap'n Web RPC 入口，负责 `apiToken -> AuthedApi`、token 吊销、tool specs 和 tool dispatch。
- `UsageBillingPlugin`：上游用量/计费插件，按 `userId + provider + operation + model` 汇总调用、延迟、输入输出体积、单位用量和成本。
- `ZhipuProviderPlugin`：智谱 OpenAPI provider，依赖 shared usage recorder，保存 API Key，并为 gateway tools / 插件 UI 提供 OCR、文件解析、搜索、模型、embedding、rerank 等内部调用能力。
- `YiqichaProviderPlugin`：亿企查 provider，保存凭据、维护 API catalog，并通过少量 gateway tools 暴露企业数据能力。
