import { describe, expect, it } from 'vitest'

import { BasePlugin, Plugin, setParamToken, withHost } from '@pluxel/test'

describe('PluginService registration state', () => {
	it('updates registered plugin set across commits', async () => {
		await withHost(async (host) => {
			@Plugin({ name: 'REG-B' })
			class B extends BasePlugin {}

			@Plugin({ name: 'REG-C' })
			class C extends BasePlugin {}

			@Plugin({ name: 'REG-A' })
			class A extends BasePlugin {
				constructor(public readonly dep: B) {
					super()
				}
			}
			setParamToken(A, 0, B)

			const readPluginSet = () => new Set<any>(host.plugins())

			host.add([B, C, A])
			await host.commit()
			expect(readPluginSet()).toEqual(new Set([B, C, A]))

			host.restart(A)
			host.remove(A)
			await host.commit()
			expect(readPluginSet()).toEqual(new Set([B, C]))

			host.add(A)
			await host.commit()
			expect(readPluginSet()).toEqual(new Set([B, C, A]))
			expect(host.isRunning(A)).toBe(true)

			host.remove(A)
			await host.commit()
			expect(readPluginSet()).toEqual(new Set([B, C]))
			expect(host.isRunning(A)).toBe(false)
		})
	})
})
