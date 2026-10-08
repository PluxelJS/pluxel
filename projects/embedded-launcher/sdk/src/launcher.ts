import { Observations, observeAsync } from './observation'
import type { Context } from '@pluxel/core'
import {
	defineContextCapability,
	installRootCapability,
	installOwnerViewCapability,
	enterOwnerInvocation,
	type CoreCommitPublication,
} from '@pluxel/core/host'
import { defineHostService } from '@pluxel/host'
import { encodeJson, type Json, type NativeTransport } from './wire'

export interface QueryInput {
	revision: number
	text: string
	limit: number
	signal: AbortSignal
}
export interface QueryResult {
	id: string
	title: string
	subtitle: string
	action: { label: string; execute(signal: AbortSignal): Promise<Json> }
}
export interface LauncherApi {
	register(id: string, query: (input: QueryInput) => Promise<readonly QueryResult[]>): void
}
type Provider = {
	owner: Context
	id: string
	query: (input: QueryInput) => Promise<readonly QueryResult[]>
	active: boolean
}
type Action = { provider: Provider; revision: number; execute: QueryResult['action']['execute'] }
export const Launcher = defineContextCapability<LauncherApi>('launcher.queries', {
	access: 'owner',
})
export const LauncherControl = defineContextCapability<LauncherRegistry>('launcher.control', {
	access: 'root',
})

export class LauncherRegistry {
	readonly lease = crypto.randomUUID()
	private readonly candidates = new Map<Context, Provider[]>()
	private published: readonly Provider[] = []
	private prepared: readonly Provider[] = []
	private readonly actions = new Map<string, Action>()
	private nextHandle = 0
	private queryRevision = -1
	private queryController?: AbortController
	private contributionRevision = 0
	private change?: () => void
	private stopped = false
	private pumping?: Promise<void>
	constructor(private readonly transport: NativeTransport) {}
	register(owner: Context, id: string, query: Provider['query']) {
		if (!id || id.length > 80) throw new TypeError('Provider id must contain 1–80 characters')
		const admission = enterOwnerInvocation(owner)
		admission.dispose()
		const records = this.candidates.get(owner) ?? []
		if (records.some((record) => record.active && record.id === id))
			throw new Error(`Duplicate provider: ${id}`)
		const record = { owner, id, query, active: true }
		records.push(record)
		this.candidates.set(owner, records)
		owner.effects.defer(
			() => {
				record.active = false
				this.candidates.delete(owner)
				this.invalidateActions()
			},
			{ tag: `Launcher:${id}` },
		)
	}
	prepare(publication: CoreCommitPublication) {
		const stopped = new Set<Context>(publication.stopped)
		this.prepared = this.published.filter(
			(provider) => provider.active && !stopped.has(provider.owner),
		)
		const next = [...this.prepared]
		for (const owner of publication.started)
			next.push(...(this.candidates.get(owner) ?? []).filter((provider) => provider.active))
		const ids = new Set<string>()
		for (const provider of next) {
			if (ids.has(provider.id))
				throw new Error(`Duplicate committed Launcher provider: ${provider.id}`)
			ids.add(provider.id)
		}
		this.prepared = Object.freeze(next)
	}
	publish(publication: CoreCommitPublication): undefined {
		this.published = this.prepared
		if (publication.started.length > 0 || publication.stopped.length > 0) {
			this.contributionRevision++
			this.change?.()
		}
		return undefined
	}
	private invalidateActions() {
		this.actions.clear()
		this.queryController?.abort(new Error('Query superseded'))
	}
	async query(input: { revision: number; text: string; limit: number }) {
		if (this.stopped) throw new Error('Host lease closed')
		if (
			!Number.isSafeInteger(input.revision) ||
			input.revision < this.queryRevision ||
			typeof input.text !== 'string' ||
			input.text.length > 512 ||
			!Number.isInteger(input.limit) ||
			input.limit < 1 ||
			input.limit > 30
		)
			throw new TypeError('Invalid or stale query')
		this.invalidateActions()
		this.queryRevision = input.revision
		const controller = (this.queryController = new AbortController())
		const results: {
			id: string
			title: string
			subtitle: string
			action: { handle: string; label: string }
		}[] = []
		const errors: { provider: string; message: string }[] = []
		for (const provider of this.published) {
			if (!provider.active || results.length >= input.limit) continue
			let admission: ReturnType<typeof enterOwnerInvocation> | undefined
			try {
				admission = enterOwnerInvocation(provider.owner, controller.signal)
				const batch = await provider.query({
					...input,
					limit: input.limit - results.length,
					signal: admission.signal,
				})
				if (
					admission.signal.aborted ||
					controller.signal.aborted ||
					this.queryController !== controller ||
					!provider.active
				)
					throw new Error('Query superseded')
				for (const item of batch.slice(0, input.limit - results.length)) {
					if (
						typeof item.id !== 'string' ||
						typeof item.title !== 'string' ||
						typeof item.subtitle !== 'string' ||
						typeof item.action?.label !== 'string' ||
						typeof item.action.execute !== 'function'
					)
						throw new TypeError('Invalid Launcher result')
					const handle = `${this.lease}:${++this.nextHandle}`
					this.actions.set(handle, {
						provider,
						revision: input.revision,
						execute: item.action.execute,
					})
					results.push({
						id: `${provider.id}:${item.id}`,
						title: item.title,
						subtitle: item.subtitle,
						action: { handle, label: item.action.label },
					})
				}
			} catch (error) {
				if (controller.signal.aborted || this.queryController !== controller)
					throw new Error('Query superseded', { cause: error })
				errors.push({
					provider: provider.id,
					message: error instanceof Error ? error.message : String(error),
				})
			} finally {
				admission?.dispose()
			}
		}
		return { lease: this.lease, revision: input.revision, results, errors }
	}
	async action(handle: string): Promise<Json> {
		const action = this.actions.get(handle)
		if (
			this.stopped ||
			!action ||
			!action.provider.active ||
			action.revision !== this.queryRevision
		)
			throw new Error('Action handle revoked')
		this.actions.delete(handle)
		const admission = enterOwnerInvocation(action.provider.owner)
		try {
			const result = await action.execute(admission.signal)
			encodeJson(result)
			return result
		} finally {
			admission.dispose()
		}
	}
	async start() {
		await this.transport.request('host.attach', { lease: this.lease })
		this.pumping = this.pump()
	}
	private async pump() {
		let sent = -1
		while (!this.stopped) {
			if (sent === this.contributionRevision)
				await new Promise<void>((resolve) => {
					this.change = resolve
				})
			this.change = undefined
			if (this.stopped) break
			sent = this.contributionRevision
			try {
				await this.transport.request('launcher.invalidate', {
					lease: this.lease,
					contributionRevision: sent,
				})
			} catch (error) {
				if (!this.stopped) console.error('Launcher projection delivery failed', error)
				break
			}
		}
	}
	async close() {
		if (this.stopped) return
		this.stopped = true
		this.invalidateActions()
		this.change?.()
		await this.pumping
		await this.transport.request('host.detach', { lease: this.lease })
	}
}
export function launcher(transport: NativeTransport, observed = false) {
	return defineHostService({
		name: 'Launcher',
		capabilities: [
			installRootCapability(LauncherControl, { create: () => new LauncherRegistry(transport) }),
			installOwnerViewCapability(Launcher, {
				createRoot: (root) => root.require(LauncherControl),
				createView: (registry, owner) => {
					const metric = observed
						? owner.root.require(Observations).acquire(owner, 'Launcher')
						: undefined
					return Object.freeze({
						register(id: string, query: Provider['query']) {
							registry.register(owner, id, async (input) =>
								observeAsync(metric, input.signal, async () => {
									const result = await query(input)
									return result.map((item) => ({
										id: item.id,
										title: item.title,
										subtitle: item.subtitle,
										action: {
											label: item.action.label,
											execute: (signal: AbortSignal) =>
												observeAsync(metric, signal, () => item.action.execute(signal)),
										},
									}))
								}),
							)
							const finish = metric?.begin()
							if (finish)
								owner.effects.defer(() => finish({ outcome: 'completed', bodyBytesRead: 0 }), {
									tag: 'Observed Launcher subscription',
								})
						},
					})
				},
			}),
		],
		lifecycle(root) {
			const registry = root.require(LauncherControl)
			return {
				prepareCommit: (publication) => registry.prepare(publication),
				publishCommit: (publication) => registry.publish(publication),
			}
		},
		async prepare({ ctx, effects }) {
			const registry = ctx.require(LauncherControl)
			effects.defer(() => registry.close())
			await registry.start()
		},
	})
}
