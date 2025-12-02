import { existsSync } from 'node:fs'
import { dirname, resolve } from 'pathe'
import { normalizePath } from 'vite'
import { ModuleCacheMap } from 'vite-node/client'
import { createHmrDebug } from './logging'

const nsToMs = (ns: bigint) => Number(ns) / 1e6
type NumMap = Map<string, number>
const bump = (m: NumMap, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v)

export const findNearestPackageRoot = (start: string): string | null => {
	try {
		let current = normalizePath(start)
		while (true) {
			if (existsSync(resolve(current, 'package.json'))) return normalizePath(current)
			const parent = dirname(current)
			if (parent === current) return null
			current = parent
		}
	} catch {
		return null
	}
}

export const startTimer = () => {
	const t0 = process.hrtime.bigint()
	return () => nsToMs(process.hrtime.bigint() - t0)
}

export class Mutex {
	private q = Promise.resolve()
	run<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.q.then(fn, fn)
		this.q = next.then(
			() => {},
			() => {},
		)
		return next
	}
}

type BatchDebounceReason = 'debounce' | 'maxwait' | 'maxbatch'
const defaultBatchDebounceErrorHandler = (error: unknown) => {
	console.error('[BatchDebouncer] flush failed', error)
}

export class BatchDebouncer {
	private pending = new Set<string>()
	private t: NodeJS.Timeout | null = null
	private tMax: NodeJS.Timeout | null = null
	private epoch = 0
	constructor(
		private flushFn: (files: string[], epoch: number) => Promise<void>,
		private debounceMs: number,
		private maxWaitMs: number,
		private maxBatchFiles: number,
		private readonly onError: (error: unknown) => void = defaultBatchDebounceErrorHandler,
	) {}
	push(id: string) {
		this.pending.add(id)
		if (!this.t) this.t = setTimeout(() => this.flush('debounce'), this.debounceMs)
		if (!this.tMax) this.tMax = setTimeout(() => this.flush('maxwait'), this.maxWaitMs)
		if (this.pending.size >= this.maxBatchFiles) this.flush('maxbatch')
	}
	private flush(_reason: BatchDebounceReason) {
		if (!this.pending.size) return
		this.clearTimers()
		const files = [...this.pending]
		this.pending.clear()
		const epoch = ++this.epoch
		this.runFlush(files, epoch)
	}
	private clearTimers() {
		if (this.t) {
			clearTimeout(this.t)
			this.t = null
		}
		if (this.tMax) {
			clearTimeout(this.tMax)
			this.tMax = null
		}
	}
	private async runFlush(files: string[], epoch: number) {
		try {
			await this.flushFn(files, epoch)
		} catch (error) {
			this.onError(error)
		}
	}
}

export type TimingBucket = 'transform' | 'evaluate' | 'inject'

export class TimingTracker {
	private readonly debugEntry
	private readonly buckets: Record<TimingBucket, NumMap> = {
		transform: new Map<string, number>(),
		evaluate: new Map<string, number>(),
		inject: new Map<string, number>(),
	}

	constructor(
		private readonly options: {
			useColors: boolean
			formatId: (id: string) => string
		},
	) {
		this.debugEntry = createHmrDebug('pluxel:hmr:time:entry', options.useColors)
	}

	clear() {
		for (const bucket of Object.values(this.buckets)) bucket.clear()
	}

	start(kind: TimingBucket, id: string) {
		const t0 = process.hrtime.bigint()
		return () => {
			const durationMs = nsToMs(process.hrtime.bigint() - t0)
			this.record(kind, id, durationMs)
			return durationMs
		}
	}

	record(kind: TimingBucket, id: string, durationMs: number) {
		bump(this.buckets[kind], id, durationMs)
		if (this.debugEntry.enabled) {
			const total = this.buckets[kind].get(id) ?? durationMs
			this.debugEntry('%s %p %t (agg=%t)', kind, this.options.formatId(id), durationMs, total)
		}
	}

	top(kind: TimingBucket, n = 5) {
		return [...this.buckets[kind].entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
	}

	snapshot() {
		return {
			transformMs: this.buckets.transform,
			evalMs: this.buckets.evaluate,
			injectMs: this.buckets.inject,
		}
	}
}

export class NormalizedModuleCacheMap extends ModuleCacheMap {
	constructor(private readonly normalize: (id: string) => string) {
		super()
	}

	override normalizePath(fsPath: string): string {
		return this.normalize(fsPath)
	}
}
