import { BasePlugin, Plugin } from '@pluxel/core'
import { defineNodeModule, nodeModules } from '@pluxel/services/node'
import { defineWorkerTask, workers } from '@pluxel/services/workers'
import { createTestHost } from '@pluxel/test'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const worker = defineWorkerTask<{ value: number }, { value: number; threadId: number }>(
	import.meta.url,
	'./fixtures/node-worker.ts',
)
const nodeEntry = defineNodeModule(import.meta.url, './fixtures/node-worker.ts')

@Plugin()
class NodeConsumer extends BasePlugin {
	capabilities() {
		return { nodeModules: 'nodeModules' in this.ctx, workers: 'workers' in this.ctx }
	}

	async artifact(declaration = nodeEntry) {
		let artifact: URL | undefined
		await this.ctx.nodeModules.use(declaration, (url) => {
			artifact = url
		})
		return artifact!
	}

	run(value: number) {
		return this.ctx.workers.run(worker, { value })
	}
}

describe('test host Node source compiler', () => {
	it('compiles TypeScript on demand and executes it in a real worker', async () => {
		let artifact: URL
		{
			await using host = await createTestHost({ services: [nodeModules(), workers()] })
			const plugin = await host.start(NodeConsumer)
			const result = await plugin.run(21)
			expect(result.value).toBe(42)
			expect(result.threadId).toBeGreaterThan(0)
			artifact = await plugin.artifact()
			expect(existsSync(artifact)).toBe(true)
		}
		expect(existsSync(artifact!)).toBe(false)
	})

	it('isolates concurrent hosts and keeps the surviving host usable', async () => {
		await using first = await createTestHost({ services: [nodeModules(), workers()] })
		await using second = await createTestHost({ services: [nodeModules(), workers()] })
		const [a, b] = await Promise.all([first.start(NodeConsumer), second.start(NodeConsumer)])
		const [aUrl, bUrl] = await Promise.all([a.artifact(), b.artifact()])
		expect(aUrl.href).not.toBe(bUrl.href)
		await first.dispose()
		expect(existsSync(aUrl)).toBe(false)
		expect(existsSync(bUrl)).toBe(true)
		await expect(b.run(7)).resolves.toMatchObject({ value: 14 })
	})

	it('reports a failed compilation and can still compile a valid entry', async () => {
		await using fixture = await createDiskFixture({ 'broken.ts': 'export default = ;' })
		await using host = await createTestHost({ services: [nodeModules()] })
		const plugin = await host.start(NodeConsumer)
		const broken = defineNodeModule(pathToFileURL(fixture.getPath('owner.ts')), './broken.ts')
		await expect(plugin.artifact(broken)).rejects.toThrow(Error)
		const url = await plugin.artifact()
		expect(existsSync(url)).toBe(true)
	})

	it.each(['root', 'resolve'] as const)(
		'respects explicit packaged artifact %s instead of silently compiling source',
		async (mode) => {
			await using fixture = await createDiskFixture({ 'ready.mjs': 'export default 42' })
			const options =
				mode === 'root'
					? { root: dirname(fixture.getPath('ready.mjs')) }
					: { resolve: () => fixture.getPath('ready.mjs') }
			const packaged = Reflect.apply(defineNodeModule, undefined, [
				import.meta.url,
				'./missing-source.ts',
				'ready',
			]) as ReturnType<typeof defineNodeModule>
			await using host = await createTestHost({ services: [nodeModules(options)] })
			const plugin = await host.start(NodeConsumer)
			const artifact = await plugin.artifact(packaged)
			expect(artifact.href).toBe(pathToFileURL(fixture.getPath('ready.mjs')).href)
			await expect(plugin.artifact()).rejects.toThrow(/no packaged artifact/)
		},
	)

	it('does not install Node services for a bare host', async () => {
		await using host = await createTestHost()
		const plugin = await host.start(NodeConsumer)
		expect(plugin.capabilities()).toEqual({ nodeModules: false, workers: false })
	})
})
