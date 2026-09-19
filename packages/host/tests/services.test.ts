import {
	defineContextCapability,
	installRootCapability,
	resolveContextCapability,
} from '@pluxel/core/host'
import { describe, expect, it } from 'vitest'
import { createHost, defineHostService, type HostService } from '../src/index'

describe('static Host service preparation', () => {
	it('validates the entire plan before calling any factory or prepare callback', async () => {
		let creations = 0
		const Provider = defineContextCapability<number>('provider')
		const Other = defineContextCapability<number>('other')
		const installation = installRootCapability(Provider, { create: () => ++creations })
		const provider = defineHostService({ name: 'provider', capabilities: [installation] })
		const other = defineHostService({
			name: 'other',
			capabilities: [installRootCapability(Other, { create: () => ++creations })],
			requires: { provider: Provider },
			prepare: () => {
				creations++
			},
		})
		await expect(createHost({ plugins: [], services: [provider, provider] })).rejects.toMatchObject(
			{ code: 'DUPLICATE_CAPABILITY' },
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
						capabilities: [
							installRootCapability(Other, { property: 'logger', create: () => ++creations }),
						],
					}),
				] as HostService[],
			}),
		).rejects.toThrow('duplicate property logger')
		expect(creations).toBe(0)
	})

	it('prepares providers first, isolates two roots, and closes dependent resources before providers', async () => {
		const events: string[] = []
		let serial = 0
		const Provider = defineContextCapability<{ id: number }>('provider')
		const Consumer = defineContextCapability<number>('consumer')
		const provider = defineHostService({
			name: 'provider',
			capabilities: [
				installRootCapability(Provider, { property: 'provider', create: () => ({ id: ++serial }) }),
			],
			prepare({ ctx, effects }) {
				const { id } = resolveContextCapability(ctx, Provider)
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
			capabilities: [installRootCapability(Consumer, { create: () => 42 })],
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
		const installedId: number = first.ctx.provider.id
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
		const Provider = defineContextCapability<number>('provider')
		const Consumer = defineContextCapability<number>('consumer')
		const failure = new Error('preflight failed')
		const provider = defineHostService({
			name: 'provider',
			capabilities: [installRootCapability(Provider, { create: () => 1 })],
			prepare({ effects }) {
				effects.defer(() => {
					events.push('provider')
				})
			},
		})
		const consumer = defineHostService({
			name: 'consumer',
			capabilities: [installRootCapability(Consumer, { create: () => 2 })],
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
