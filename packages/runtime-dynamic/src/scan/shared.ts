import { isAbsolute, normalize, resolve as r } from 'pathe'
import type { ResolvedScanOptions } from './types'

export function normalizeScanInputs(input: string | string[]): string[] {
	const list = Array.isArray(input) ? input : [input]
	const out = new Set<string>()
	for (const raw of list) {
		const trimmed = typeof raw === 'string' ? raw.trim() : ''
		const candidate = trimmed || '.'
		const abs = isAbsolute(candidate) ? candidate : r(process.cwd(), candidate)
		out.add(normalize(abs))
	}
	if (out.size === 0) {
		return [normalize(r(process.cwd(), '.'))]
	}
	return [...out].sort()
}

export function resolveScanRoots(defaultRoots: string[], override?: string | string[]): string[] {
	if (override === undefined) return defaultRoots
	return normalizeScanInputs(override)
}

export function createScanCacheKey(inputs: string[], options: ResolvedScanOptions): string {
	return JSON.stringify([[...inputs].sort(), options])
}

export function createLimiter(concurrency: number) {
	let active = 0
	const queue: Array<() => void> = []

	const next = () => {
		active--
		queue.shift()?.()
	}

	return function run<T>(task: () => Promise<T>): Promise<T> {
		return new Promise((resolve, reject) => {
			const execute = async () => {
				active++
				try {
					resolve(await task())
				} catch (error) {
					reject(error)
				} finally {
					next()
				}
			}

			if (active < concurrency) void execute()
			else queue.push(() => void execute())
		})
	}
}
