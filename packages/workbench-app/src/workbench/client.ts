import { pluginNodeIndexKey } from '@pluxel/core'
import type { RpcStub } from '@pluxel/runtime/capnweb'
import { readWorkbenchLayout, type WorkbenchSessionApi } from '@pluxel/runtime/workbench/client'
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
	listeners: Set<() => void>
	snapshot: WorkbenchTargetSnapshot
}

/** One-epoch layout owner. The server invalidates the whole socket when its inventory changes. */
export class WorkbenchLayoutRuntime implements Disposable {
	readonly #targets = new Map<string, TargetEntry>()
	#active = true

	constructor(private readonly session: RpcStub<WorkbenchSessionApi>) {}

	retain(target: WorkbenchTargetId): () => void {
		this.#assertActive()
		const entry = this.#entry(target)
		entry.refs += 1
		if (entry.refs === 1 && !entry.snapshot.layout && entry.request === null) {
			void this.#load(target, entry)
		}
		let active = true
		return () => {
			if (!active) return
			active = false
			entry.refs -= 1
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
		for (const entry of this.#targets.values()) entry.listeners.clear()
		this.#targets.clear()
	}

	#entry(target: WorkbenchTargetId): TargetEntry {
		const key = target === null ? '$global' : pluginNodeIndexKey(target)
		let entry = this.#targets.get(key)
		if (!entry) {
			entry = {
				refs: 0,
				request: null,
				listeners: new Set(),
				snapshot: createInitialWorkbenchSnapshot(target),
			}
			this.#targets.set(key, entry)
		}
		return entry
	}

	async #load(target: WorkbenchTargetId, entry: TargetEntry): Promise<void> {
		const request = readWorkbenchLayout(this.session, { target })
			.then(
				(layout): undefined => {
					if (!this.#active) return undefined
					entry.snapshot = compileWorkbenchSnapshot(target, layout)
					this.#notify(entry)
					return undefined
				},
				(error: unknown): undefined => {
					if (!this.#active) return undefined
					entry.snapshot = Object.freeze({
						...entry.snapshot,
						state: 'error' as const,
						error: toWorkbenchError(error, 'Workbench layout could not be loaded'),
					})
					this.#notify(entry)
					return undefined
				},
			)
			.finally(() => {
				if (entry.request === request) entry.request = null
			})
		entry.request = request
		await request
	}

	#notify(entry: TargetEntry): void {
		const listeners = [...entry.listeners]
		for (const listener of listeners) listener()
	}

	#assertActive(): void {
		if (!this.#active) throw new Error('Workbench layout runtime is disposed')
	}
}
