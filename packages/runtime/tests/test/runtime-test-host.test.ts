import { describe, expect, it } from 'vitest'
import { BasePlugin, createRuntimeHost, Plugin } from '@pluxel/runtime/test'
import { lowerTestPlugin } from '../helpers/lowered-plugin'

describe('runtime/test host', () => {
	it('starts plugins through the real runtime context', async () => {
		const host = createRuntimeHost()
		try {
			@Plugin()
			class Dep extends BasePlugin {}

			@Plugin()
			class Consumer extends BasePlugin {
				constructor(readonly dep: Dep) {
					super()
				}
			}
			lowerTestPlugin(Dep)
			lowerTestPlugin(Consumer, { requires: [Dep] })
			host.add([Dep, Consumer])
			host.cfg(Dep).enable()
			host.cfg(Consumer).enable()
			await host.commit()

			const consumer = host.require(Consumer)
			expect(consumer.dep).toBeInstanceOf(Dep)
			expect(host.require(Dep)).toBeInstanceOf(Dep)
			expect(host.isRunning(Dep)).toBe(true)
			expect(host.isRunning(Consumer)).toBe(true)
		} finally {
			await host.dispose()
		}
	})
})
