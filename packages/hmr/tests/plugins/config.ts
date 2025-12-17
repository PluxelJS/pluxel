import { f, v } from '@pluxel/hmr/config'

/** Polling 配置 schema */
const PollingConfigSchema = v.object({
	timeoutMs: v.pipe(
		v.optional(v.number(), 25000),
		f.formMeta({ label: '超时时间', description: '长轮询超时时间（毫秒）' }),
		f.numberMeta({ min: 1000, max: 60000, step: 1000 }),
	),
	limit: v.pipe(
		v.optional(v.number(), 50),
		f.formMeta({ label: '获取数量', description: '每次获取的更新数量限制' }),
		f.numberMeta({ min: 1, max: 100, step: 1 }),
	),
	idleDelayMs: v.pipe(
		v.optional(v.number(), 300),
		f.formMeta({ label: '空闲延迟', description: '无更新时的等待时间（毫秒）' }),
		f.numberMeta({ min: 50, max: 5000, step: 50 }),
	),
	allowedUpdates: v.pipe(
		v.optional(
			v.pipe(
				v.array(v.string()),
				f.arrayMeta({ layout: 'list', addLabel: '添加类型', itemLabel: '类型' }),
			),
		),
		f.formMeta({ label: '允许的更新类型', description: '不设置则接收所有类型' }),
	),
})

/** Webhook 配置 schema */
const WebhookConfigSchema = v.object({
	url: v.pipe(
		v.string(),
		v.url(),
		f.formMeta({ label: 'Webhook URL', description: '接收更新的 HTTPS URL' }),
		f.stringMeta({ placeholder: 'https://your-domain.com/webhook' }),
	),
	secretToken: v.pipe(
		v.optional(v.string()),
		f.formMeta({ label: '密钥 Token', description: '用于验证 Webhook 请求' }),
		f.stringMeta({ mode: 'password', placeholder: '可选' }),
	),
	maxConnections: v.pipe(
		v.optional(v.number(), 40),
		f.formMeta({ label: '最大连接数', description: '同时进行的 HTTPS 连接数' }),
		f.numberMeta({ min: 1, max: 100, step: 1 }),
	),
	dropPendingUpdates: v.pipe(
		v.optional(v.boolean(), false),
		f.formMeta({ label: '丢弃待处理更新', description: '设置 Webhook 时是否丢弃所有待处理更新' }),
		f.booleanMeta({ variant: 'switch' }),
	),
	allowedUpdates: v.pipe(
		v.optional(
			v.pipe(
				v.array(v.string()),
				f.arrayMeta({ layout: 'list', addLabel: '添加类型', itemLabel: '类型' }),
			),
		),
		f.formMeta({ label: '允许的更新类型' }),
	),
})

/** 单个 Bot 配置（Polling 模式） */
const PollingBotSchema = v.object({
	mode: v.literal('polling'),
	token: v.pipe(
		v.string(),
		v.minLength(1),
		f.formMeta({ label: 'Bot Token', description: 'Telegram Bot Token' }),
		f.stringMeta({ mode: 'password', placeholder: '123456789:ABCdefGHIjklMNOpqrsTUVwxyz' }),
	),
	polling: v.optional(PollingConfigSchema, {}),
})

/** 单个 Bot 配置（Webhook 模式） */
const WebhookBotSchema = v.object({
	mode: v.literal('webhook'),
	token: v.pipe(
		v.string(),
		v.minLength(1),
		f.formMeta({ label: 'Bot Token', description: 'Telegram Bot Token' }),
		f.stringMeta({ mode: 'password', placeholder: '123456789:ABCdefGHIjklMNOpqrsTUVwxyz' }),
	),
	webhook: WebhookConfigSchema,
})

const ApiBotSchema = v.object({
	mode: v.literal('api'),
	token: v.pipe(
		v.string(),
		v.minLength(1),
		f.formMeta({ label: 'Bot Token', description: 'Telegram Bot Token（仅 API）' }),
		f.stringMeta({ mode: 'password', placeholder: '123456789:ABCdefGHIjklMNOpqrsTUVwxyz' }),
	),
})

/** Bot 配置联合类型 */
export const SingleBotConfig = v.pipe(
	v.variant('mode', [PollingBotSchema, WebhookBotSchema, ApiBotSchema]),
	f.formMeta({ label: '机器人配置' }),
	f.unionMeta({
		discriminator: 'mode',
		branchLabels: { polling: '轮询模式', webhook: 'Webhook 模式', api: '仅 API' },
		branchDescriptions: {
			polling: '主动拉取更新，适合开发和测试',
			webhook: '被动接收更新，需要 HTTPS 服务器',
			api: '仅调用 HTTP API，不接收更新',
		},
		variant: 'segmented',
	}),
)

/** 主配置 schema */
export const TelegramConfig = v.object({
	apiBase: v.pipe(
		v.optional(v.pipe(v.string(), v.url()), 'https://api.telegram.org'),
		f.formMeta({ label: 'API 基础 URL', description: '可用于代理服务器' }),
		f.stringMeta({ placeholder: 'https://api.telegram.org' }),
	),
	syncCommands: v.pipe(
		v.optional(v.boolean(), true),
		f.formMeta({ label: '自动同步指令', description: '启动时自动将注册的指令同步到 Telegram' }),
		f.booleanMeta({ variant: 'switch' }),
	),
	bots: v.pipe(
		v.optional(v.record(v.string(), SingleBotConfig), {}),
		f.formMeta({ label: '机器人列表', description: '配置多个 Telegram 机器人' }),
		f.recordMeta({
			layout: 'list',
			addLabel: '添加机器人',
			keyLabel: '机器人名称',
			keyPlaceholder: '如 main-bot',
			valueLabel: '机器人配置',
		}),
	),
})

export type TelegramConfigType = typeof TelegramConfig
