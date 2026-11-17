import { expect, it } from 'vitest'
import { createHost, defineHostService, type PluginHost } from '../src/index'

it('awaits scope-owned Host shutdown and shares cleanup with concurrent close calls', async () => {
	const entered = Promise.withResolvers<void>()
	const released = Promise.withResolvers<void>()
	let host!: PluginHost
	let cleanups = 0
	let settled = false
	const service = defineHostService({
		name: 'scoped-resource',
		capabilities: [],
		prepare({ effects }) {
			effects.defer(async () => {
				cleanups++
				entered.resolve()
				await released.promise
			})
		},
	})
	const operation = (async () => {
		await using scoped = await createHost({ plugins: [], services: [service] })
		host = scoped
		await host.start()
	})().then((): void => {
		settled = true
		return undefined
	})
	try {
		await entered.promise
		expect(settled).toBe(false)
		expect(host.close()).toBe(host[Symbol.asyncDispose]())
		expect(() => host.start()).toThrow('closed')
	} finally {
		released.resolve()
		await operation
	}
	expect(settled).toBe(true)
	expect(cleanups).toBe(1)
	await host[Symbol.asyncDispose]()
	expect(cleanups).toBe(1)
})

it('preserves body and cleanup failures when a Host leaves its async disposal scope', async () => {
	const bodyFailure = new Error('application failed')
	const cleanupFailure = new Error('resource close failed')
	const events: string[] = []
	let host!: PluginHost
	const operation = async () => {
		await using scoped = await createHost({
			plugins: [],
			services: [
				defineHostService({
					name: 'failed-resource',
					capabilities: [],
					prepare({ effects }) {
						effects.defer(() => {
							events.push('remaining cleanup')
						})
						effects.defer(() => {
							events.push('failed cleanup')
							throw cleanupFailure
						})
					},
				}),
			],
		})
		host = scoped
		throw bodyFailure
	}
	const failure = await operation().catch((error: unknown) => error)
	expect(failure).toBeInstanceOf(SuppressedError)
	const suppressed = failure as SuppressedError
	expect(suppressed.suppressed).toBe(bodyFailure)
	expect(suppressed.error).toBeInstanceOf(AggregateError)
	expect(suppressed.error.message).toBe('[host] shutdown failed')
	expect(events).toEqual(['failed cleanup', 'remaining cleanup'])
	await expect(host.close()).rejects.toBe(suppressed.error)
	expect(events).toHaveLength(2)
})
