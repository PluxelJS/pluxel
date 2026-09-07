import { describe, expect, it, vi } from 'vitest'

describe('Context kernel identity', () => {
	it('allows independent evaluations to coexist and diagnoses cross-kernel values', async () => {
		const first = await import('../src')
		vi.resetModules()
		const second = await import('../src')

		expect(first.createContextHost).not.toBe(second.createContextHost)

		const firstCapability = first.defineContextCapability<string>('test.first-kernel')
		const firstHost = first.createContextHost({
			name: 'first-kernel',
			capabilities: [
				first.installRootCapability(firstCapability, {
					create: () => 'first',
				}),
			],
		})
		const firstRoot = firstHost.createRoot()

		const secondCapability = second.defineContextCapability<string>('test.second-kernel')
		const secondHost = second.createContextHost({
			name: 'second-kernel',
			capabilities: [
				second.installRootCapability(secondCapability, {
					create: () => 'second',
				}),
			],
		})
		const secondRoot = secondHost.createRoot()

		expect(first.resolveContextCapability(firstRoot, firstCapability)).toBe('first')
		expect(second.resolveContextCapability(secondRoot, secondCapability)).toBe('second')

		const resolveForeignContext = () =>
			second.resolveContextCapability(
				firstRoot as unknown as Parameters<typeof second.resolveContextCapability>[0],
				secondCapability,
			)
		expect(resolveForeignContext).toThrow(TypeError)
		expect(resolveForeignContext).toThrow('belongs to a different evaluated Context kernel')
		expect(resolveForeignContext).toThrow(
			'evaluated more than once through HMR or workspace resolution',
		)

		const resolveForeignCapability = () =>
			second.resolveContextCapability(
				secondRoot,
				firstCapability as unknown as typeof secondCapability,
			)
		expect(resolveForeignCapability).toThrow(TypeError)
		expect(resolveForeignCapability).toThrow(
			'Context capability descriptor belongs to a different evaluated Context kernel',
		)
		expect(resolveForeignCapability).toThrow('from the same evaluated kernel instance')
	})

	it('keeps diagnostic probes safe for hostile invalid objects', async () => {
		const kernel = await import('../src')
		const capability = kernel.defineContextCapability<string>('test.diagnostic-safety')
		const root = kernel
			.createContextHost({
				name: 'diagnostic-safety',
				capabilities: [kernel.installRootCapability(capability, { create: () => 'value' })],
			})
			.createRoot()
		const hostileContext = Object.create(null)
		Object.defineProperty(hostileContext, Symbol.toStringTag, {
			get: () => {
				throw new Error('hostile Context tag')
			},
		})
		const hostileCapability = new Proxy(Object.freeze({ description: 'hostile' }), {
			ownKeys: () => {
				throw new Error('hostile descriptor keys')
			},
		})

		expect(() => kernel.resolveContextCapability(hostileContext as never, capability)).toThrow(
			'[pluxel/context] Invalid Context implementation',
		)
		expect(() => kernel.resolveContextCapability(root, hostileCapability as never)).toThrow(
			'[pluxel/context] Invalid Context capability descriptor',
		)
	})
})
