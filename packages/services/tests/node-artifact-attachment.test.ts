import { createHost } from '@pluxel/host'
import { nodeModules } from '@pluxel/services/node'
import { attachNodeArtifactCompiler, nodeArtifacts } from '@pluxel/services/node/vite'
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

it('rejects explicit source compilation when the host owns packaged artifact configuration', async () => {
	const host = await createHost({
		plugins: [],
		services: [nodeModules({ root: '/packaged/artifacts/node' })],
	})
	try {
		expect(() => attachNodeArtifactCompiler(host.ctx)).toThrow(
			/conflicts with explicit artifact configuration/,
		)
		await expect(
			nodeArtifacts().api!.pluxelHost.attach({
				host,
				catalog: { plugins: [], modules: [], definitions: [] },
				get server(): never {
					throw new Error('packaged artifacts must not access the Vite server')
				},
				get profile(): never {
					throw new Error('packaged artifacts need no execution profile')
				},
				get semantics(): never {
					throw new Error('packaged artifacts need no source compiler')
				},
			}),
		).resolves.toBeUndefined()
	} finally {
		await host.close()
	}
})
