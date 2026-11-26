import type { Workbench } from '@pluxel/workbench'
import { BasePlugin, Plugin, defineServiceRef } from '@pluxel/core'
import { assertWorkbenchDto, createWorkbenchWatch } from '@pluxel/workbench/server'
import { RpcTarget } from 'capnweb'
import { BotWorkspaceWorkbench } from './BotWorkspace.workbench'
import type {
	BotDetail,
	BotDetailApi,
	BotEvent,
	BotIdentity,
	BotMutationResult,
	BotObserver,
	BotSourceRegistration,
	BotWorkspaceApi,
	BotWorkspaceSnapshot,
	StoredBot,
} from './BotWorkspace.contracts'

const WorkbenchRef = defineServiceRef<Workbench>()
type Source = {
	label: string
	capability: string
	active?: BotSourceRegistration
	lastKnown: readonly StoredBot[]
	revisions: Map<string, number>
}
function isBotIdentifier(value: unknown): value is string {
	return typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value)
}

function readBots(store: BotSourceRegistration['store']): readonly StoredBot[] {
	const ids = new Set<string>()
	return store
		.list()
		.map(({ id, name, account, group, running, messages, unread, instructions }) => {
			if (!isBotIdentifier(id)) throw new Error(`Invalid bot ID: ${id}`)
			if (ids.has(id)) throw new Error(`Duplicate bot ID: ${id}`)
			ids.add(id)
			return Object.freeze({ id, name, account, group, running, messages, unread, instructions })
		})
}
const failure = (
	code: Extract<BotMutationResult, { ok: false }>['code'],
	message: string,
): BotMutationResult => ({ ok: false, code, message })

@Plugin({ displayName: '机器人工作区 · 多来源聚合' })
export class BotWorkspacePlugin extends BasePlugin {
	private readonly sources = new Map<string, Source>()
	private readonly listeners = new Set<(revision: number) => void>()
	private readonly events: BotEvent[] = []
	private revision = 0

	override init(): void {
		this.ctx.service(WorkbenchRef)?.publish(BotWorkspaceWorkbench, {
			home: ({ signal }) => new WorkspaceTarget(this, signal),
			list: ({ signal }) => new WorkspaceTarget(this, signal),
			bot: ({ signal, params }) => {
				const identity = this.identity(params.source, params.bot)
				this.detail(identity)
				return new DetailTarget(this, signal, identity)
			},
			sources: () => ({
				subscribe: (changed) => this.subscribe(changed),
				load: () => ({
					sources: this.snapshot().sources.map(({ label, available, count }) => ({
						label,
						available,
						count,
					})),
				}),
			}),
			events: () => ({
				subscribe: (changed) => this.subscribe(changed),
				load: () => ({ events: this.snapshot().events }),
			}),
		})
	}

	/** One live registration per source. The source owns release; all mutations are synchronous. */
	registerSource(registration: BotSourceRegistration): () => void {
		if (!isBotIdentifier(registration.id)) throw new Error('Invalid bot source ID')
		if (this.sources.get(registration.id)?.active)
			throw new Error(`Source already registered: ${registration.id}`)
		const source: Source = {
			label: registration.label,
			capability: registration.capability,
			active: registration,
			lastKnown: readBots(registration.store),
			revisions: new Map(),
		}
		this.sources.set(registration.id, source)
		this.record(registration.id, '', '来源已连接（模拟）')
		let released = false
		return () => {
			if (released) return
			released = true
			if (this.sources.get(registration.id) !== source) return
			delete source.active
			this.record(registration.id, '', '来源已停止；保留最后已知数据')
		}
	}

	snapshot(): BotWorkspaceSnapshot {
		const sources = [...this.sources].map(([id, source]) => ({
			id,
			label: source.label,
			available: !!source.active,
			count: source.lastKnown.length,
			capability: source.capability,
		}))
		const bots = [...this.sources].flatMap(([source, state]) =>
			state.lastKnown.map((bot) => {
				const { instructions: _, ...summary } = bot
				return { ...summary, source, available: !!state.active }
			}),
		)
		return {
			revision: this.revision,
			sources,
			bots,
			events: this.events.map((event) => ({
				source: event.source,
				bot: event.bot,
				at: event.at,
				message: event.message,
			})),
		}
	}

	identity(source: unknown, id: unknown): BotIdentity {
		if (!isBotIdentifier(source) || !isBotIdentifier(id)) throw new Error('Invalid bot identity')
		return Object.freeze({ source, id })
	}

	detail(identity: BotIdentity): BotDetail {
		const source = this.sources.get(identity.source)
		const bot = source?.lastKnown.find((item) => item.id === identity.id)
		if (!source || !bot) throw new Error('Bot not found')
		return {
			...bot,
			source: identity.source,
			available: !!source.active,
			revision: source.revisions.get(identity.id)!,
			capability: source.capability,
			...(source.active?.editor && { editor: source.active.editor(bot) }),
			events: this.events
				.filter(
					(event) =>
						event.source === identity.source && (event.bot === identity.id || event.bot === ''),
				)
				.map((event) => ({
					source: event.source,
					bot: event.bot,
					at: event.at,
					message: event.message,
				})),
		}
	}

	update(identity: BotIdentity, input: unknown, operation: 'save' | 'running'): BotMutationResult {
		if (!input || typeof input !== 'object' || Array.isArray(input))
			return failure('invalid_input', '请求格式不正确')
		const value = input as Record<string, unknown>
		const field = operation === 'save' ? 'instructions' : 'running'
		if (
			Object.keys(value).some((key) => key !== field && key !== 'expectedRevision') ||
			!Number.isSafeInteger(value.expectedRevision) ||
			(operation === 'save'
				? typeof value.instructions !== 'string' ||
					value.instructions.trim().length === 0 ||
					value.instructions.length > 4000
				: typeof value.running !== 'boolean')
		)
			return failure('invalid_input', '请检查内容和版本；指令需为 1–4000 个字符')
		const source = this.sources.get(identity.source)
		if (!source?.active || !source.lastKnown.some((bot) => bot.id === identity.id))
			return failure('unavailable', '来源当前不可用，请等待来源恢复')
		if (source.revisions.get(identity.id) !== value.expectedRevision)
			return failure('conflict', '数据已变化，请重新载入后再保存')
		source.active.store.update(
			identity.id,
			operation === 'save'
				? { instructions: value.instructions as string }
				: { running: value.running as boolean },
		)
		source.lastKnown = readBots(source.active.store)
		this.record(
			identity.source,
			identity.id,
			operation === 'save'
				? '已更新机器人指令'
				: value.running
					? '已启动机器人（模拟）'
					: '已暂停机器人（模拟）',
		)
		return { ok: true }
	}

	subscribe(listener: (revision: number) => void): Disposable {
		this.listeners.add(listener)
		return {
			[Symbol.dispose]: () => {
				this.listeners.delete(listener)
			},
		}
	}

	private record(source: string, bot: string, message: string): void {
		this.revision++
		const state = this.sources.get(source)!
		for (const item of state.lastKnown)
			if (!bot || item.id === bot) state.revisions.set(item.id, this.revision)
		this.events.unshift({ source, bot, at: new Date().toISOString(), message })
		this.events.splice(40)
		this.ctx.logger.info(message, { source, bot })
		for (const listener of Array.from(this.listeners)) listener(this.revision)
	}
}

class WorkspaceTarget extends RpcTarget implements BotWorkspaceApi {
	constructor(
		private readonly workspace: BotWorkspacePlugin,
		private readonly signal: AbortSignal,
	) {
		super()
	}
	snapshotDto(): BotWorkspaceSnapshot {
		const snapshot = this.workspace.snapshot()
		assertWorkbenchDto(snapshot)
		return snapshot
	}
	watch(observer: BotObserver): RpcTarget {
		return createWorkbenchWatch({
			observer,
			signal: this.signal,
			subscribe: (notify) => this.workspace.subscribe(notify),
		})
	}
}

class DetailTarget extends RpcTarget implements BotDetailApi {
	constructor(
		private readonly workspace: BotWorkspacePlugin,
		private readonly signal: AbortSignal,
		private readonly identity: BotIdentity,
	) {
		super()
	}
	snapshotDto(): BotDetail {
		const detail = this.workspace.detail(this.identity)
		assertWorkbenchDto(detail)
		return detail
	}
	watch(observer: BotObserver): RpcTarget {
		return createWorkbenchWatch({
			observer,
			signal: this.signal,
			subscribe: (notify) => this.workspace.subscribe(notify),
		})
	}
	saveDto(input: { instructions: string; expectedRevision: number }): BotMutationResult {
		const result = this.workspace.update(this.identity, input, 'save')
		assertWorkbenchDto(result)
		return result
	}
	setRunningDto(input: { running: boolean; expectedRevision: number }): BotMutationResult {
		const result = this.workspace.update(this.identity, input, 'running')
		assertWorkbenchDto(result)
		return result
	}
}
