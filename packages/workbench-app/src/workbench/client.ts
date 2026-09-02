import { pluginNodeIndexKey } from '@pluxel/core'
import type { RpcStub } from '@pluxel/runtime/capnweb'
import {
	readWorkbenchLayout,
	type WorkbenchLayout,
	type WorkbenchSessionApi,
} from '@pluxel/runtime/workbench/client'
import { matchWorkbenchRoute } from './routes'
import { normalizeWorkbenchPath } from './paths'
import { toWorkbenchError } from './errors'
import {
	compileWorkbenchSnapshot,
	createInitialWorkbenchSnapshot,
	type WorkbenchResolvedRoute,
	type WorkbenchTargetId,
	type WorkbenchTargetSnapshot,
} from './client-snapshot'

export type {
	WorkbenchResolvedRoute,
	WorkbenchTargetId,
	WorkbenchTargetSnapshot,
	WorkbenchTargetState,
} from './client-snapshot'

type TargetEntry = {
	refs: number
	request: Promise<void> | null
	refreshTimer: ReturnType<typeof setTimeout> | null
	listeners: Set<() => void>
	snapshot: WorkbenchTargetSnapshot
}

const WORKBENCH_LAYOUT_STATUS_POLL_MS = 1_000

export type WorkbenchLayoutRuntimeOptions = Readonly<{
	statusPollMs?: number
}>

/** Layout owner for one socket epoch. Inventory changes still invalidate the whole socket. */
export class WorkbenchLayoutRuntime implements Disposable {
	readonly #targets = new Map<string, TargetEntry>()
	readonly #statusPollMs: number
	#active = true

	constructor(
		private readonly session: RpcStub<WorkbenchSessionApi>,
		options: WorkbenchLayoutRuntimeOptions = {},
	) {
		this.#statusPollMs = readStatusPollMs(options.statusPollMs)
	}

	retain(target: WorkbenchTargetId): () => void {
		this.#assertActive()
		const entry = this.#entry(target)
		entry.refs += 1
		if (entry.refs === 1) {
			if (!entry.snapshot.layout && entry.request === null) void this.#load(target, entry)
			else this.#scheduleStatusRefresh(target, entry)
		}
		let active = true
		return () => {
			if (!active) return
			active = false
			entry.refs -= 1
			if (entry.refs === 0) this.#clearStatusRefresh(entry)
		}
	}

	subscribe(target: WorkbenchTargetId, listener: () => void): () => void {
		this.#assertActive()
		const entry = this.#entry(target)
		entry.listeners.add(listener)
		return () => entry.listeners.delete(listener)
	}

	getSnapshot(target: WorkbenchTargetId): WorkbenchTargetSnapshot {
		return this.#entry(target).snapshot
	}

	resolveRoute(target: WorkbenchTargetId, path: string): WorkbenchResolvedRoute | undefined {
		const normalized = normalizeWorkbenchPath(path)
		for (const route of this.getSnapshot(target).routes) {
			const params = matchWorkbenchRoute(route.compiled, normalized)
			if (!params) continue
			const placement = route.entry.placement
			if (placement.kind !== 'route') continue
			return Object.freeze({
				entry: route.entry,
				location: normalized,
				params,
				frame: placement.frame,
			})
		}
		return undefined
	}

	[Symbol.dispose](): void {
		if (!this.#active) return
		this.#active = false
		for (const entry of this.#targets.values()) {
			this.#clearStatusRefresh(entry)
			entry.listeners.clear()
		}
		this.#targets.clear()
	}

	#entry(target: WorkbenchTargetId): TargetEntry {
		const key = target === null ? '$global' : pluginNodeIndexKey(target)
		let entry = this.#targets.get(key)
		if (!entry) {
			entry = {
				refs: 0,
				request: null,
				refreshTimer: null,
				listeners: new Set(),
				snapshot: createInitialWorkbenchSnapshot(target),
			}
			this.#targets.set(key, entry)
		}
		return entry
	}

	async #load(target: WorkbenchTargetId, entry: TargetEntry): Promise<void> {
		this.#clearStatusRefresh(entry)
		const request = readWorkbenchLayout(this.session, { target })
			.then(
				(layout): undefined => {
					if (!this.#active) return undefined
					try {
						const next = compileWorkbenchSnapshot(target, layout)
						if (entry.snapshot.state === 'ready' && sameLayoutRevision(entry.snapshot, next)) {
							return undefined
						}
						entry.snapshot = next
					} catch (error) {
						this.#publishError(entry, error, 'Workbench layout could not be compiled')
						return undefined
					}
					this.#notify(entry)
					return undefined
				},
				(error: unknown): undefined => {
					if (!this.#active) return undefined
					this.#publishError(entry, error, 'Workbench layout could not be loaded')
					return undefined
				},
			)
			.finally(() => {
				if (entry.request === request) {
					entry.request = null
					this.#scheduleStatusRefresh(target, entry)
				}
			})
		entry.request = request
		await request
	}

	#scheduleStatusRefresh(target: WorkbenchTargetId, entry: TargetEntry): void {
		if (
			!this.#active ||
			entry.refs === 0 ||
			entry.request !== null ||
			entry.refreshTimer !== null
		) {
			return
		}
		const layout = entry.snapshot.layout
		if (!layout || !hasUnavailableFederatedEntry(layout)) return
		const timer = setTimeout(() => {
			if (entry.refreshTimer === timer) entry.refreshTimer = null
			if (!this.#active || entry.refs === 0 || entry.request !== null) return
			void this.#load(target, entry)
		}, this.#statusPollMs)
		unrefTimer(timer)
		entry.refreshTimer = timer
	}

	#clearStatusRefresh(entry: TargetEntry): void {
		const timer = entry.refreshTimer
		if (!timer) return
		entry.refreshTimer = null
		clearTimeout(timer)
	}

	#notify(entry: TargetEntry): void {
		const listeners = [...entry.listeners]
		for (const listener of listeners) listener()
	}

	#publishError(entry: TargetEntry, error: unknown, fallbackMessage: string): void {
		entry.snapshot = Object.freeze({
			...entry.snapshot,
			state: 'error' as const,
			error: toWorkbenchError(error, fallbackMessage),
		})
		this.#notify(entry)
	}

	#assertActive(): void {
		if (!this.#active) throw new Error('Workbench layout runtime is disposed')
	}
}

function hasUnavailableFederatedEntry(layout: WorkbenchLayout): boolean {
	return layout.entries.some(
		(entry) => !('contentRef' in entry) && entry.federatedViewUnavailable !== undefined,
	)
}

function sameLayoutRevision(
	left: WorkbenchTargetSnapshot,
	right: WorkbenchTargetSnapshot,
): boolean {
	return left.layout?.revision === right.layout?.revision
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
	if (typeof window !== 'undefined') return
	;(timer as ReturnType<typeof setTimeout> & { unref?(): void }).unref?.()
}

function readStatusPollMs(input: number | undefined): number {
	if (input === undefined) return WORKBENCH_LAYOUT_STATUS_POLL_MS
	if (!Number.isFinite(input) || input < 10 || input > 60_000) {
		throw new TypeError('[workbench-app] statusPollMs is invalid')
	}
	return input
}
