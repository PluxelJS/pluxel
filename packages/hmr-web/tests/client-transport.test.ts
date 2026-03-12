import { afterEach, describe, expect, it, vi } from 'vitest'

import { createHmrTransport } from '../src/client'

const originalWindow = globalThis.window

describe('createHmrTransport', () => {
	afterEach(() => {
		if (originalWindow === undefined) vi.unstubAllGlobals()
		else vi.stubGlobal('window', originalWindow)
	})

	it('resolves same-origin transport links to absolute browser URLs', () => {
		vi.stubGlobal('window', {
			location: { origin: 'http://localhost:3000' },
		} as Window)

		const transport = createHmrTransport()

		expect(transport.apiBase).toBe('http://localhost:3000/__pluxel/hmr')
		expect(transport.rpc).toBe('http://localhost:3000/__pluxel/hmr/rpc')
		expect(transport.logsFollow('default')).toBe(
			'http://localhost:3000/__pluxel/hmr/logs/v1/streams/default/follow',
		)
		expect(transport.extensionEvents(['extensions'])).toBe(
			'http://localhost:3000/__pluxel/hmr/extensions/events?ns=extensions',
		)
	})
})
