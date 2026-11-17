import { installRootService } from '@pluxel/core/host'
import { resolveContextService } from '@pluxel/core/internal'
import { describe, expect, it } from 'vitest'
import { createHost, defineHostService, type HostService } from '../src/index'

export abstract class Provider {
	abstract readonly id: number
}
export abstract class Other {
	abstract readonly value: number
}
export abstract class Consumer {
	abstract readonly value: number
}

describe('static Host service preparation', () => {
	it('rejects malformed service declarations when they are captured', () => {
		expect(() => defineHostService({ name: 'broken' } as HostService)).toThrow(
			'[host] service broken must provide a services installation list',
		)
	})

	it('captures service selection before asynchronous Host validation', async () => {
		const events: string[] = []
		const services: HostService[] = [
			{
				name: 'selected',
				provides: [],
				prepare() {
					events.push('selected')
				},
			},
		]
		const creating = createHost({ plugins: [], services })
		services[0] = {
			name: 'changed',
			provides: [],
			prepare() {
				events.push('changed')
			},
		}
		const host = await creating
		try {
			expect(events).toEqual(['selected'])
		} finally {
			await host.close()
		}
	})

	it('validates the entire plan before calling any factory or prepare callback', async () => {
		let creations = 0
		const installation = installRootService(Provider, { create: () => ({ id: ++creations }) })
		const provider = defineHostService({ name: 'provider', provides: [installation] })
		const other = defineHostService({
			name: 'other',
			provides: [installRootService(Other, { create: () => ({ value: ++creations }) })],
			requires: { provider: Provider },
			prepare: () => {
				creations++
			},
		})
		await expect(createHost({ plugins: [], services: [provider, provider] })).rejects.toMatchObject(
			{ code: 'DUPLICATE_SERVICE' },
		)
		await expect(createHost({ plugins: [], services: [other] })).rejects.toMatchObject({
			code: 'MISSING_DEPENDENCY',
		})
		await expect(
			createHost({ plugins: [], services: [{ ...provider, requires: { other: Other } }, other] }),
		).rejects.toMatchObject({ code: 'DEPENDENCY_CYCLE' })
		await expect(
			createHost({
				plugins: [],
				services: [
					provider,
					defineHostService({
						name: 'collision',
						provides: [installRootService(Provider, { create: () => ({ id: ++creations }) })],
					}),
				] as HostService[],
			}),
		).rejects.toMatchObject({ code: 'DUPLICATE_SERVICE' })
		expect(creations).toBe(0)
	})

	it('prepares providers first, isolates two roots, and closes dependent resources before providers', async () => {
		const events: string[] = []
		let serial = 0
		const provider = defineHostService({
			name: 'provider',
			provides: [installRootService(Provider, { create: () => ({ id: ++serial }) })],
			prepare({ ctx, effects }) {
				const { id } = resolveContextService(ctx, Provider)
				events.push(`prepare provider ${id}`)
				effects.defer(
					() => {
						events.push(`close provider ${id}`)
					},
					{ phase: 'shutdown' },
				)
			},
		})
		const consumer = defineHostService({
			name: 'consumer',
			provides: [installRootService(Consumer, { create: () => ({ value: 42 }) })],
			requires: { provider: Provider },
			prepare({ dependencies, effects }) {
				const id: number = dependencies.provider.id
				events.push(`prepare consumer ${id}`)
				effects.defer(
					() => {
						events.push(`close consumer ${id}`)
					},
					{ phase: 'final' },
				)
			},
		})
		const first = await createHost({ plugins: [], services: [consumer, provider] })
		const second = await createHost({ plugins: [], services: [consumer, provider] })
		const installedId: number = first.ctx.service(Provider).id
		expect(installedId).toBe(1)
		const closing = first.close()
		expect(first.close()).toBe(closing)
		await closing
		await second.close()
		expect(events).toEqual([
			'prepare provider 1',
			'prepare consumer 1',
			'prepare provider 2',
			'prepare consumer 2',
			'close consumer 1',
			'close provider 1',
			'close consumer 2',
			'close provider 2',
		])
	})

	it('cleans partial preparation in reverse order, continuing after cleanup failure and retaining the cause', async () => {
		const events: string[] = []
		const failure = new Error('preflight failed')
		const provider = defineHostService({
			name: 'provider',
			provides: [installRootService(Provider, { create: () => ({ id: 1 }) })],
			prepare({ effects }) {
				effects.defer(() => {
					events.push('provider')
				})
			},
		})
		const consumer = defineHostService({
			name: 'consumer',
			provides: [installRootService(Consumer, { create: () => ({ value: 2 }) })],
			requires: { provider: Provider },
			async prepare({ effects }) {
				effects.defer(() => {
					events.push('consumer')
					throw new Error('close failed')
				})
				throw failure
			},
		})
		await expect(createHost({ plugins: [], services: [consumer, provider] })).rejects.toMatchObject(
			{ cause: failure },
		)
		expect(events).toEqual(['consumer', 'provider'])
	})
})
