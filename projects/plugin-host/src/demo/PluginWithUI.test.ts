import { createRuntimeTestHost } from '@pluxel/runtime/test'
import { describe, expect, it, vi } from 'vitest'
import { PluginWithUI } from './PluginWithUI'
import { PluginWithUIWorkbench } from './PluginWithUI.workbench'

const principal = Object.freeze({ provider: 'local', subject: 'plugin-host-test' })

describe('PluginWithUI Workbench observer', () => {
	it('delivers updates through a disposable Workbench observer subscription', async () => {
		await using host = createRuntimeTestHost({ workbench: { enabled: true } })
		await host.start(PluginWithUI)
		using opened = await host.workbench.open({
			target: PluginWithUI,
			entry: PluginWithUIWorkbench.overview,
			principal,
		})

		let updateCount = 0
		const observe = () => {
			updateCount++
		}
		{
			using _subscription = await opened.api.watch(observe)
			await opened.api.increment()
			await vi.waitFor(() => expect(updateCount).toBe(1))
		}

		await opened.api.increment()
		await Promise.resolve()
		expect(updateCount).toBe(1)
	})
})
