import type { BotSourceId } from './BotWorkspace.contracts'
import type { Store } from 'tinybase'
import * as v from 'valibot'

export type StoredBot = Readonly<{
	id: string
	name: string
	account: string
	group: string
	running: boolean
	messages: number
	unread: number
	instructions: string
}>

const EditableBot = v.strictObject({
	instructions: v.pipe(
		v.string(),
		v.minLength(1),
		v.maxLength(4000),
		v.check((text) => !!text.trim()),
	),
	running: v.boolean(),
})

/** Native mutations update memory immediately; Host autosave and shutdown confirm persistence. */
export class BotStore {
	private readonly bots: Map<string, StoredBot>
	constructor(
		bots: readonly StoredBot[],
		private readonly store: Store,
	) {
		this.bots = new Map(bots.map((bot) => [bot.id, Object.freeze({ ...bot })]))
		if (store.getTableIds().some((id) => id !== 'bots') || store.getValueIds().length > 0) {
			throw new TypeError('Bot preferences contain unknown tables or values')
		}
		for (const [id, row] of Object.entries(store.getTable('bots'))) {
			if (!this.bots.has(id)) throw new TypeError(`Bot preferences contain an unknown bot: ${id}`)
			v.parse(EditableBot, row)
		}
	}
	list(): readonly StoredBot[] {
		return [...this.bots.values()].map(
			(bot) =>
				Object.freeze({
					...bot,
					...this.store.getRow('bots', bot.id),
				}) as StoredBot,
		)
	}
	update(id: string, patch: Readonly<{ instructions?: string; running?: boolean }>): void {
		const bot = this.bots.get(id)
		if (!bot) throw new Error(`Unknown bot: ${id}`)
		const current = this.store.getRow('bots', id)
		const next = v.parse(EditableBot, {
			instructions: current.instructions ?? bot.instructions,
			running: current.running ?? bot.running,
			...patch,
		})
		this.store.setRow('bots', id, next)
	}
}

export type BotSourceRegistration = Readonly<{
	id: BotSourceId
	label: string
	capability: string
	store: BotStore
}>

export function simulatedBots(source: BotSourceId): readonly StoredBot[] {
	return [
		{
			id: 'support',
			name: '客服助手',
			account: `${source}-support`,
			group: '客户服务',
			running: true,
			messages: 128,
			unread: 3,
			instructions: '礼貌回答客户的问题，遇到无法确认的情况转交人工。',
		},
		{
			id: 'ops',
			name: source === 'wecom' ? '值班通知' : '社区助手',
			account: `${source}-ops`,
			group: '团队协作',
			running: false,
			messages: 42,
			unread: 0,
			instructions: '汇总团队消息，只发送明确确认的通知。',
		},
	]
}
