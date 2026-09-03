import { createRuntimeHost } from '@pluxel/runtime/test'
import { describe, expect, it } from 'vitest'
import { {{className}}Plugin } from '{{packageName}}'

describe('{{className}}Plugin', () => {
	it('starts inside a host with validated config metadata', async () => {
		await using host = createRuntimeHost({ workbench: false })
		host.add({{className}}Plugin)
		host.cfg({{className}}Plugin).set({ message: 'configured' })
		host.start({{className}}Plugin)
		await host.commit()

		expect(host.isRunning({{className}}Plugin)).toBe(true)
		expect(host.require({{className}}Plugin).message()).toBe('configured')
	})
})
