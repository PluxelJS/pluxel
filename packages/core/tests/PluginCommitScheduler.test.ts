import { stopPluginsTopo } from '../src/plugins/runtime/commit'
import { describe, expect, it } from 'vitest'

describe('stopPluginsTopo', () => {
	it('stops sequentially in stable reverse-topological order', async () => {
		const dependents = new Map<string, string[]>([
			['root', ['left', 'right']],
			['left', ['leaf']],
			['right', []],
			['leaf', []],
		])
		const order: string[] = []

		await stopPluginsTopo(
			(id) => dependents.get(id) ?? [],
			new Set(['root', 'left', 'right', 'leaf']),
			async (id) => {
				order.push(id)
			},
		)

		expect(order).toEqual(['right', 'leaf', 'left', 'root'])
	})

	it('continues sequential teardown after a stop failure', async () => {
		const dependents = new Map<string, string[]>([
			['provider', ['consumer']],
			['consumer', []],
		])
		const order: string[] = []

		await stopPluginsTopo(
			(id) => dependents.get(id) ?? [],
			new Set(['provider', 'consumer']),
			async (id) => {
				order.push(id)
				if (id === 'consumer') throw new Error('stop failed')
			},
		)

		expect(order).toEqual(['consumer', 'provider'])
	})

	it('breaks a cycle without stopping a node twice', async () => {
		const dependents = new Map<string, string[]>([
			['a', ['b']],
			['b', ['a']],
		])
		const order: string[] = []

		await stopPluginsTopo(
			(id) => dependents.get(id) ?? [],
			new Set(['a', 'b']),
			async (id) => {
				order.push(id)
			},
		)

		expect(order).toEqual(['a', 'b'])
	})

	it('keeps the bounded concurrent scheduler for concurrency above one', async () => {
		const started: string[] = []
		let release!: () => void
		const released = new Promise<void>((resolve) => {
			release = resolve
		})
		let bothStarted!: () => void
		const didStartBoth = new Promise<void>((resolve) => {
			bothStarted = resolve
		})

		const stopping = stopPluginsTopo(
			() => [],
			new Set(['a', 'b']),
			async (id) => {
				started.push(id)
				if (started.length === 2) bothStarted()
				await released
			},
			{ concurrency: 2 },
		)

		await didStartBoth
		expect(started).toEqual(['a', 'b'])
		release()
		await stopping
	})
})
