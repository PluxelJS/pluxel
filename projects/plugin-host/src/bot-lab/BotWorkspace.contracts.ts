import type { RpcTarget } from 'capnweb'
import type { WorkbenchEntryLink } from '@pluxel/workbench'

export type BotIdentity = Readonly<{ source: string; id: string }>
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
export type BotPreferences = Pick<StoredBot, 'instructions' | 'running'>
export type BotSourceRegistration = Readonly<{
	/** Lowercase ASCII letter, followed by up to 63 lowercase letters, digits or hyphens. */
	id: string
	label: string
	capability: string
	/** update applies synchronously; the center reads the resulting list before returning. */
	store: {
		list(): readonly StoredBot[]
		update(id: string, patch: Partial<BotPreferences>): void
	}
	editor?(bot: StoredBot): WorkbenchEntryLink
}>
export type BotSummary = BotIdentity &
	Omit<StoredBot, 'instructions'> &
	Readonly<{ available: boolean }>
export type BotSourceSummary = Readonly<{
	id: string
	label: string
	available: boolean
	count: number
	capability: string
}>
export type BotEvent = Readonly<{ source: string; bot: string; at: string; message: string }>
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
		editor?: WorkbenchEntryLink
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
