import { describe, expect, it } from 'vitest'
import { createCoreContextHost } from '../src/host'
import { createCorePluginExecutionBinding, requirePluginService } from '../src/internal'

it('binds execution exactly once before the fixed PluginService is acquired', async () => {
	const executionBinding = createCorePluginExecutionBinding()
	const root = createCoreContextHost({ executionBinding }).createRoot()
	try {
		expect(() => requirePluginService(root)).toThrow('has not been bound')
		const values = { startTimeoutMs: 10_000 }
		executionBinding.bind(values)
		values.startTimeoutMs = 1
		expect(executionBinding.read().startTimeoutMs).toBe(10_000)
		expect(() => executionBinding.bind({})).toThrow('already bound')
		expect(requirePluginService(root)).toBe(requirePluginService(root))
	} finally {
		await root.effects.dispose()
	}
})

describe('Core immediate execution policy', () => {
	it('rejects competing execution authorities and forged bindings', () => {
		expect(() =>
			createCoreContextHost({ plugins: {}, executionBinding: createCorePluginExecutionBinding() }),
		).toThrow('cannot be supplied together')
		expect(() => createCoreContextHost({ executionBinding: {} as never })).toThrow(
			'Invalid Plugin execution binding',
		)
	})
})
