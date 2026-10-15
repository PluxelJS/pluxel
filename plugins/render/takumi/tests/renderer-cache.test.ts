import type { Renderer } from '@takumi-rs/core'
import { describe, expect, it } from 'vitest'
import { getWorkerRenderer } from '../src/renderer-cache.ts'

function backend() {
	return class {} as unknown as typeof Renderer
}

describe('worker font-set resource cache', () => {
	it('uses content and metadata across cloned input, owning retained bytes', async () => {
		const Backend = backend()
		const data = new Uint8Array([1, 2, 3])
		const first = getWorkerRenderer(Backend, [{ name: 'Report', data }])
		data[0] = 9
		const repeated = getWorkerRenderer(Backend, [
			{ name: 'Report', data: new Uint8Array([1, 2, 3]) },
		])
		expect(repeated).toBe(first)
		const font = first.fonts[0]!
		if (typeof font === 'string' || !('data' in font) || typeof font.data !== 'function')
			throw new Error('Expected keyed font loader')
		expect([...new Uint8Array((await font.data()) as Uint8Array)]).toEqual([1, 2, 3])
		expect(getWorkerRenderer(Backend, [{ name: 'Report', data }])).not.toBe(first)
		for (const metadata of [
			{ name: 'Other' },
			{ weight: 700 },
			{ style: 'italic' },
			{ subsetOf: 'Report' },
			{ subsetRank: 1 },
			{ generic: 'serif' as const },
		])
			expect(
				getWorkerRenderer(Backend, [
					{ name: 'Report', data: new Uint8Array([1, 2, 3]), ...metadata },
				]),
			).not.toBe(first)
	})

	it('isolates font order and native backends and evicts the least recently used set', () => {
		const Backend = backend()
		const a = { name: 'A', data: new Uint8Array([1]) }
		const b = { name: 'B', data: new Uint8Array([2]) }
		const first = getWorkerRenderer(Backend, [a, b])
		const second = getWorkerRenderer(Backend, [b, a])
		expect(second).not.toBe(first)
		expect(getWorkerRenderer(backend(), [a, b])).not.toBe(first)
		getWorkerRenderer(Backend, [{ data: new Uint8Array([3]) }])
		getWorkerRenderer(Backend, [{ data: new Uint8Array([4]) }])
		expect(getWorkerRenderer(Backend, [a, b])).toBe(first)
		getWorkerRenderer(Backend, [{ data: new Uint8Array([5]) }])
		expect(getWorkerRenderer(Backend, [a, b])).toBe(first)
		expect(getWorkerRenderer(Backend, [b, a])).not.toBe(second)
	})
})
