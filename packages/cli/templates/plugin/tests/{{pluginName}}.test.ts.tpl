import { createTestHost } from '@pluxel/test'
import { describe, expect, it } from 'vitest'
import { {{className}}Plugin } from '{{packageName}}'

describe('{{className}}Plugin', () => {
	it('starts inside a host with validated config metadata', async () => {
		await using host = await createTestHost()
		const node = {{className}}Plugin.nodeAddress()
		await host.start(node, {
			initialConfig: { message: 'configured' },
		})

		expect(host.isRunning(node)).toBe(true)
		expect(host.require(node).message()).toBe('configured')
	})
})
