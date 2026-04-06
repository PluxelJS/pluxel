import { describe, expect, it } from 'vitest'
import { createUiRpcView } from '../../src/web/rpc'

describe('runtime/web createUiRpcView', () => {
	it('caches namespace and method wrappers', async () => {
		let disposeCalls = 0
		const raw = () =>
			({
				ext: {
					Demo: {
						// Return a thenable without `.finally()` to ensure we normalize via Promise.resolve().
						hello: () => ({
							// oxlint-disable-next-line unicorn/no-thenable -- test fixture intentionally simulates a bare thenable
							then: (resolve: (value: string) => void) => resolve('ok'),
						}),
					},
				},
				dispose: () => {
					disposeCalls++
				},
			}) as any

		const rpc = createUiRpcView(raw as any) as any

		expect(rpc.Demo).toBe(rpc.Demo)
		expect(rpc.Demo.hello).toBe(rpc.Demo.hello)

		const value = await rpc.Demo.hello()
		expect(value).toBe('ok')
		expect(disposeCalls).toBe(1)
	})

	it('disposes clients for sync returns', () => {
		let disposeCalls = 0
		const raw = () =>
			({
				ext: {
					Demo: {
						ping: () => 123,
					},
				},
				dispose: () => {
					disposeCalls++
				},
			}) as any

		const rpc = createUiRpcView(raw as any) as any
		expect(rpc.Demo.ping()).toBe(123)
		expect(disposeCalls).toBe(1)
	})
})
