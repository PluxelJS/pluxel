import { existsSync } from 'node:fs'
import { dirname, resolve } from 'pathe'
import { normalizePath } from 'vite'
import { ModuleCacheMap } from 'vite-node/client'

const nsToMs = (ns: bigint) => Number(ns) / 1e6

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

export class NormalizedModuleCacheMap extends ModuleCacheMap {
	constructor(private readonly normalize: (id: string) => string) {
		super()
	}

	override normalizePath(fsPath: string): string {
		return this.normalize(fsPath)
	}
}
