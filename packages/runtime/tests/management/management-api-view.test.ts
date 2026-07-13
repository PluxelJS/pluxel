import { describe, expect, it } from 'vitest'
import { createManagementApiView } from '../../src/web/rpc'

describe('createManagementApiView', () => {
	it('caches binding and method wrappers', async () => {
		let disposeCalls = 0
		const raw = () =>
			({
				resource: (binding: string) =>
					binding === 'demo-binding'
						? {
								// Return a thenable without `.finally()` to ensure we normalize via Promise.resolve().
								hello: () => ({
									// oxlint-disable-next-line unicorn/no-thenable -- test fixture intentionally simulates a bare thenable
									then: (resolve: (value: string) => void) => resolve('ok'),
								}),
							}
						: undefined,
				dispose: () => {
					disposeCalls++
				},
			}) as any

		const rpc = createManagementApiView(raw as any) as any

		expect(rpc['demo-binding']).toBe(rpc['demo-binding'])
		expect(rpc['demo-binding'].hello).toBe(rpc['demo-binding'].hello)

		const value = await rpc['demo-binding'].hello()
		expect(value).toBe('ok')
		expect(disposeCalls).toBe(1)
	})

	it('disposes clients for sync returns', () => {
		let disposeCalls = 0
		const raw = () =>
			({
				resource: (binding: string) =>
					binding === 'demo-binding'
						? {
								ping: () => 123,
							}
						: undefined,
				dispose: () => {
					disposeCalls++
				},
			}) as any

		const rpc = createManagementApiView(raw as any) as any
		expect(rpc['demo-binding'].ping()).toBe(123)
		expect(disposeCalls).toBe(1)
	})
})
