import type { BotSourceId } from './BotWorkspace.contracts'

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

/** Ordinary domain adapter, owned by one simulated source generation. No Plugin is retained. */
export class BotStore {
	private readonly bots: Map<string, StoredBot>
	constructor(bots: readonly StoredBot[]) {
		this.bots = new Map(bots.map((bot) => [bot.id, Object.freeze({ ...bot })]))
	}
	list(): readonly StoredBot[] {
		return [...this.bots.values()]
	}
	update(id: string, patch: Readonly<{ instructions?: string; running?: boolean }>): void {
		const bot = this.bots.get(id)
		if (!bot) throw new Error(`Unknown bot: ${id}`)
		this.bots.set(id, Object.freeze({ ...bot, ...patch }))
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
