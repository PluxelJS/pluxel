import { describe, expect, it } from 'vitest'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { createRuntimeHost, setParamTokens } from '@pluxel/runtime/test'
import type { Wretch } from '@pluxel/wretch'
import { KookPlugin } from '@repo/chatbots-kook'

@Plugin({ name: 'KookWorkbenchTestHttpPlugin' })
class TestHttpPlugin extends BasePlugin {
	readonly client = {} as Wretch

	enableManagedSettings(): Promise<void> {
		return Promise.resolve()
	}

	workbenchSettings(): never {
		return {} as never
	}
}

setParamTokens(KookPlugin, [TestHttpPlugin])

describe('KookPlugin Workbench composition', () => {
	it('mounts bot management and shared HTTP settings through one extension', async () => {
		const host = createRuntimeHost()
		try {
			host.add([TestHttpPlugin, KookPlugin])
			host.cfg(TestHttpPlugin).enable()
			host.cfg(KookPlugin).enable()
			const started = await host.commitAllowFail()
			expect(started.lifecycleReport.issues).toEqual([])

			expect(host.isRunning(TestHttpPlugin)).toBe(true)
			expect(host.isRunning(KookPlugin)).toBe(true)
		} finally {
			await host.dispose()
		}
	})
})
