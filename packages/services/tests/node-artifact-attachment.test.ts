import { createHost } from '@pluxel/host'
import { nodeModules } from '@pluxel/services/node'
import { attachNodeArtifactCompiler } from '@pluxel/services/node/vite'
import { expect, it } from 'vitest'

it('has one active Node source compiler and permits reattachment after disposal', async () => {
	const host = await createHost({ plugins: [], services: [nodeModules()] })
	const first = attachNodeArtifactCompiler(host.ctx)
	try {
		expect(() => attachNodeArtifactCompiler(host.ctx)).toThrow(/already attached/)
		await first.dispose()
		await first.dispose()
		const next = attachNodeArtifactCompiler(host.ctx)
		await next.dispose()
	} finally {
		await first.dispose()
		await host.close()
	}
})
