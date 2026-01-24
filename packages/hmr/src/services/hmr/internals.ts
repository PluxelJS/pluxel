import { existsSync } from 'node:fs'
import { getLogger } from '@logtape/logtape'
import { pluxelCategories } from '@pluxel/core/logger'
import { dirname, resolve } from 'pathe'
import { normalizePath } from 'vite'

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

export function matchesSpecifierPattern(specifier: string, pattern: string) {
	if (!pattern) return false
	if (pattern.endsWith('/*')) {
		const prefix = pattern.slice(0, -1) // keep trailing slash
		return specifier.startsWith(prefix)
	}
	return specifier === pattern || specifier.startsWith(`${pattern}/`)
}

type BatchDebounceReason = 'debounce' | 'maxwait' | 'maxbatch'
const batchDebouncerLogger = getLogger([...pluxelCategories.hmr, 'BatchDebouncer'])
const defaultBatchDebounceErrorHandler = (error: unknown) => {
	batchDebouncerLogger.error('flush failed', { error })
}

export class BatchDebouncer {
	private pending = new Set<string>()
	private t: NodeJS.Timeout | null = null
	private tMax: NodeJS.Timeout | null = null
	private epoch = 0
	private inFlight: Promise<void> = Promise.resolve()
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
		this.enqueueFlush(files, epoch)
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
	private enqueueFlush(files: string[], epoch: number) {
		this.inFlight = this.inFlight
			.then(() => this.flushFn(files, epoch))
			.catch((error) => this.onError(error))
	}
}
