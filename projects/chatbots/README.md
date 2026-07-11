# Chatbots for Pluxel

基于当前 Pluxel static runtime 重写的聊天机器人插件集群。旧仓库只作为需求样本，不作为兼容目标。

## 现在包含什么

- `ChatHubPlugin`：transport-neutral 消息路由、去重、会话内串行、跨会话并行、处理器隔离。
- `ChatCommandsPlugin`：可选的轻量文本命令插件；不是内核的一部分。
- `ChatBuiltinsPlugin`：`/ping`、`/help`、`/status`。
- `ChatSandboxPlugin`：无需平台凭据即可进行 HTTP 端到端测试。
- `TelegramAdapterPlugin`：Telegram long polling adapter，带 Vault 管理面板。
- `KookAdapterPlugin`：KOOK gateway adapter、完整 v3 API client 和 Vault 管理面板。

## 运行

```bash
pnpm install
pnpm --filter @repo/project-chatbots start
```

默认地址为 `http://127.0.0.1:3314`，直接打开即为 Pluxel 管理界面。两个 adapter 始终运行以提供配置页面；没有 Token 时保持 `unconfigured`，不会连接外部平台。`pnpm ... static` 只提供无前端编译器的 headless 宿主。

沙箱接口位于插件路由：

```bash
curl -s http://127.0.0.1:3314/__pluxel/plugins/ChatSandboxPlugin/api/messages \
  -H 'content-type: application/json' \
  -d '{"text":"/ping"}'
```

响应中的 `replies` 应包含 `pong`。查看状态和历史：

```text
GET  /__pluxel/plugins/ChatSandboxPlugin/api/status
GET  /__pluxel/plugins/ChatSandboxPlugin/api/messages
POST /__pluxel/plugins/ChatSandboxPlugin/api/reset
```

## 启用 Telegram

打开 Pluxel 中的 `Telegram Bot` 设置页，填写 Bot Token 后点击“保存并连接”。Token 只写入持久化加密 Vault，SignalDB 和浏览器端只能看到是否存在及掩码。设置页还提供鉴权测试、重连、断开和删除 Token。

## 启用 KOOK

打开 Pluxel 中的 `KOOK Bot` 设置页，填写 Bot Token 后点击“保存并连接”。插件会用 Vault 中的凭据调用 `user/me`，随后获取 gateway 并建立 WebSocket。设置页支持 API Base、鉴权测试、重连、断开及删除 Token；群聊 conversation id 为 `channel:<channelId>`，私聊为 `direct:<userId>`。

完整 KOOK OpenAPI client 从 `@repo/chatbots-kook/api` 导出。84 个 v3 endpoints 由 `endpoints.txt` 在构建期通过 macro 内联，避免手写方法表漂移；client 同时提供强类型具名方法、`$raw.request/$raw.call` 逃生口，以及 `$tool` 的频道/私聊 conversation、上传、回复、编辑、跟踪和临时消息工具。

插件 UI 使用模块相对声明：

```ts
const pluginUi = ui(import.meta.url, './ui/index.tsx')
```

路径到绝对文件名的转换由 Pluxel authoring API 负责，平台插件不再重复 `fileURLToPath(new URL(...))`。

## 增加业务插件

命令型能力依赖 `ChatCommandsPlugin` 并在 `init()` 注册：

```ts
@Plugin({ name: 'WeatherPlugin' })
export class WeatherPlugin extends BasePlugin {
	constructor(private readonly commands: ChatCommandsPlugin) {
		super()
	}

	override init() {
		const dispose = this.commands.register({
			name: 'weather',
			description: '查询天气',
			execute: async ({ args }) => lookupWeather(args.join(' ')),
		})
		this.ctx.effects.defer(dispose)
	}
}
```

非命令能力直接依赖 `ChatHubPlugin`，通过 `registerHandler()` 订阅稳定的 `ChatMessage`。平台专属对象只允许放在 adapter 内部；确有必要的只读数据放到 `metadata`。

更多设计取舍见 [docs/DESIGN.md](docs/DESIGN.md)，旧项目迁移映射见 [docs/MIGRATION.md](docs/MIGRATION.md)。
