import type { RpcTarget } from 'capnweb'

export type BotSourceId = 'telegram' | 'discord' | 'wecom'
export type BotIdentity = Readonly<{ source: BotSourceId; id: string }>
export type BotSummary = BotIdentity &
	Readonly<{
		name: string
		account: string
		group: string
		running: boolean
		available: boolean
		messages: number
		unread: number
	}>
export type BotSourceSummary = Readonly<{
	id: BotSourceId
	label: string
	available: boolean
	count: number
	capability: string
}>
export type BotEvent = Readonly<{ source: BotSourceId; bot: string; at: string; message: string }>
export type BotWorkspaceSnapshot = Readonly<{
	revision: number
	sources: readonly BotSourceSummary[]
	bots: readonly BotSummary[]
	events: readonly BotEvent[]
}>
export type BotDetail = BotSummary &
	Readonly<{
		revision: number
		instructions: string
		capability: string
		events: readonly BotEvent[]
	}>
export type BotMutationResult =
	| Readonly<{ ok: true }>
	| Readonly<{ ok: false; code: 'unavailable' | 'conflict' | 'invalid_input'; message: string }>
export type BotObserver = (revision: number) => void | Promise<void>
export interface BotWorkspaceApi extends RpcTarget {
	snapshotDto(): BotWorkspaceSnapshot
	watch(observer: BotObserver): RpcTarget
}
export interface BotDetailApi extends RpcTarget {
	snapshotDto(): BotDetail
	watch(observer: BotObserver): RpcTarget
	saveDto(input: { instructions: string; expectedRevision: number }): BotMutationResult
	setRunningDto(input: { running: boolean; expectedRevision: number }): BotMutationResult
}
