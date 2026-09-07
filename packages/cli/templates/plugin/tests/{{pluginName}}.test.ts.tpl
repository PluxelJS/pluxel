import { createRuntimeTestHost } from '@pluxel/runtime/test'
import { describe, expect, it } from 'vitest'
import { {{className}}Plugin } from '{{packageName}}'

describe('{{className}}Plugin', () => {
	it('starts inside a host with validated config metadata', async () => {
		await using host = createRuntimeTestHost()
		await host.start({{className}}Plugin, {
			initialConfig: { message: 'configured' },
		})

		expect(host.isRunning({{className}}Plugin)).toBe(true)
		expect(host.require({{className}}Plugin).message()).toBe('configured')
	})
})
