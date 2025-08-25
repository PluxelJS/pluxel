import type { SystemExtra } from './system'
import type { Data } from './base'
import type { MessageExtra } from './message'

export * from './base'
export * from './message'
export * from './system'
export * from './api'

export type EventSession<T> = Session<Data<SystemExtra<T>>>
export type MessageSession<T = MessageExtra> = Session<Data<T>>

export interface Session<T> {
	userId: string
	selfId: string
	guildId: string
	channelId: string
	internalData?: any
	data: T
}
