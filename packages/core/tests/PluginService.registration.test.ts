import { describe, expect, it } from 'vitest'

import { BasePlugin, Plugin, definePluginRef } from '@pluxel/core/test'
import { withCoreInternalTestHost } from '@pluxel/core/internal/test'

@Plugin({ displayName: 'REG-B' })
class RegistrationB extends BasePlugin {}

@Plugin({ displayName: 'REG-C' })
class RegistrationC extends BasePlugin {}

@Plugin({ displayName: 'REG-A' })
class RegistrationA extends BasePlugin {
	constructor(public readonly dep: RegistrationB) {
		super()
	}
}

describe('PluginService registration state', () => {
	it('fails explicitly when a raw runner bypasses semantic lowering', async () => {
		const rawDefinePluginRef = definePluginRef
		await withCoreInternalTestHost((host) => {
			@Plugin({ displayName: 'Raw Plugin' })
			class RawPlugin extends BasePlugin {}

			expect(() => host.add(RawPlugin)).toThrow(/Plugin declaration was not lowered/)
			expect(() => rawDefinePluginRef<RawPlugin>()).toThrow(/Plugin ref was not lowered/)
		})
	})

	it('updates registered plugin set across commits', async () => {
		await withCoreInternalTestHost(async (host) => {
			const readPluginSet = () => new Set<any>(host.plugins())

			host.add([RegistrationB, RegistrationC, RegistrationA])
			await host.commit()
			expect(readPluginSet()).toEqual(new Set([RegistrationB, RegistrationC, RegistrationA]))

			host.restart(RegistrationA)
			host.remove(RegistrationA)
			await host.commit()
			expect(readPluginSet()).toEqual(new Set([RegistrationB, RegistrationC]))

			host.add(RegistrationA)
			await host.commit()
			expect(readPluginSet()).toEqual(new Set([RegistrationB, RegistrationC, RegistrationA]))
			expect(host.isRunning(RegistrationA)).toBe(true)

			host.remove(RegistrationA)
			await host.commit()
			expect(readPluginSet()).toEqual(new Set([RegistrationB, RegistrationC]))
			expect(host.isRunning(RegistrationA)).toBe(false)
		})
	})
})
