import { RpcTarget } from 'capnweb'
import type { Store } from 'tinybase'
import * as v from 'valibot'
import type { DiscordChannelApi, DiscordChannelChange } from './DiscordBot.workbench'
import type { StoredBot } from './BotWorkspace.contracts'

export const channelTable = 'discordNotificationChannels'
const ChannelId = v.pipe(v.string(), v.regex(/^[1-9][0-9]{0,19}$/))
const ChannelRow = v.strictObject({ channelId: ChannelId })
const SaveChannel = v.strictObject({
	channelId: v.nullable(ChannelId),
	expectedChannelId: v.nullable(ChannelId),
})

export function validateDiscordChannels(store: Store, bots: readonly StoredBot[]): void {
	for (const [id, row] of Object.entries(store.getTable(channelTable))) {
		if (!bots.some((bot) => bot.id === id)) throw new Error(`Unknown Discord bot: ${id}`)
		v.parse(ChannelRow, row)
	}
}

/** One RPC root edits only the bot selected when its document was opened. */
export class DiscordChannelTarget extends RpcTarget implements DiscordChannelApi {
	constructor(
		private readonly bot: StoredBot,
		private readonly store: Store,
		private readonly flush: () => Promise<void>,
	) {
		super()
	}

	currentDto() {
		const channelId = this.store.hasRow(channelTable, this.bot.id)
			? v.parse(ChannelRow, this.store.getRow(channelTable, this.bot.id)).channelId
			: null
		return { name: this.bot.name, channelId }
	}

	async saveDto(input: DiscordChannelChange): ReturnType<DiscordChannelApi['saveDto']> {
		const parsed = v.safeParse(SaveChannel, input)
		if (!parsed.success)
			return {
				ok: false,
				code: 'invalid_input',
				message: '请输入 1–20 位非零开头的频道 ID，或清空此字段。',
			}
		const { channelId, expectedChannelId } = parsed.output
		const current = this.currentDto().channelId
		if (current !== expectedChannelId && current !== channelId)
			return {
				ok: false,
				code: 'conflict',
				message: '通知频道已在其他文档修改，请重新读取后再保存。',
			}
		if (current !== channelId) {
			if (channelId === null) this.store.delRow(channelTable, this.bot.id)
			else this.store.setRow(channelTable, this.bot.id, { channelId })
		}
		await this.flush()
		return { ok: true }
	}
}
