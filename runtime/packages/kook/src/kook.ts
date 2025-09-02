// KyPlugin.ts

import { type Awaitable, BasePlugin, Config, f, Plugin, v } from '@pluxel/hmr'
import type { HTTPError,  KyInstance,  Options as KyOptions } from 'pluxel-plugin-ky'
// biome-ignore lint/style/useImportType: <explanation>
import { KyPlugin } from 'pluxel-plugin-ky'
import { Bot } from './bot'
import { createCommandBus, defineCommand, defineFor } from './cmd'
import type { MessageSession } from './types'
import { KK } from './events'

const BotConfig = v.object({
	cmdPrefix: v.pipe(v.optional(v.string(), '/'), v.minLength(1), v.maxLength(1)),
	bots: v.pipe(
		v.record(v.string(), v.boolean()),
		f.recordMeta({
			valueMode: 'boolean',
			keyPlaceholder: 'token',
			valuePlaceholder: 'Webhook',
		}),
	),
})

export type Bots = Record<string, Bot>
type CMDCTX = { bot: Bot; session: MessageSession }
@Plugin({ name: 'KOOKBOT' })
export class KOOKBOT extends BasePlugin {
	@Config(BotConfig) private config!: Config<typeof BotConfig>

	/** 共享实例：其他插件直接用它 */
	public baseClient: KyInstance
	public bots: Bots = {}
	private readonly defineCmd = defineFor<CMDCTX>()
	readonly cmdBan = this.defineCmd({
		pattern: 'test <user> [reason]',
		flags: { force: Boolean },
		async action(argv, { bot, session }) {
			await bot.sendMessage(
				session.channelId,
				`test ${argv.user} ${argv.reason} ${argv.flags.force}`,
			)
		},
	})

	private readonly cmdBus = createCommandBus<CMDCTX>({}).register(this.cmdBan)

	constructor(ky: KyPlugin) {
		super()
		this.baseClient = ky.createClient({
			prefixUrl: 'https://www.kookapp.cn',
			throwHttpErrors: true,
		})
	}

	async init(_abort: AbortSignal): Promise<void> {
		// 指令处理器
		this.ctx.on(KK.MESSAGE, (bot, session, next) => {
			const msg = session.data.content
			if (msg[0] !== this.config.cmdPrefix) return next(bot, session)

			this.cmdBus
				.dispatch(msg.slice(1), { bot, session })
				.catch((e) => this.ctx.logger.error(e, `执行 ${msg} 遇到以下问题：`))
		})
		for (const token in this.config.bots) {
			const a = new Bot(
				this.baseClient.extend({ headers: { Authorization: `Bot ${token}` } }),
				this.bots,
				this.ctx,
			)
		}
	}

	async stop(abort: AbortSignal): Promise<void> {
		for (const bot of Object.values(this.bots)) {
			await bot.stop()
		}
	}
}
