import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PluginNodeAddress } from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import { PLUGIN_LOWERING_ABI_VERSION } from '@pluxel/core/toolchain'
import { expect, it } from 'vitest'
import { dynamicSource } from '../../src/dynamic/index'
import { runHostApplication } from '../../src/index'

const address = (name: string): PluginNodeAddress => ({
	definition: {
		entry: { kind: 'package-root', packageName: `@fixture/${name}` },
		exportName: 'Dynamic',
	},
	variant: 'default',
})

function builtModule(name: string): string {
	return `// [pluxel-plugin-semantics] Injected facts
import { BasePlugin, Plugin } from '@pluxel/core'
import { __setPluginDefinition } from '@pluxel/core/toolchain'
class Dynamic extends BasePlugin {}
Plugin()(Dynamic)
__setPluginDefinition(Dynamic, ${JSON.stringify({ abiVersion: PLUGIN_LOWERING_ABI_VERSION, kind: 'plugin', definition: address(name).definition })})
export { Dynamic }
`
}

it('starts the initial dynamic catalog and accepts fresh built entries and withdrawal', async () => {
	const root = await mkdtemp(fileURLToPath(new URL('./.production-source-', import.meta.url)))
	let runtime: Awaited<ReturnType<typeof runHostApplication>> | undefined
	try {
		await writeFile(join(root, 'initial.mjs'), builtModule('initial'))
		runtime = await runHostApplication(
			() => ({
				name: 'production-source',
				plugins: [],
				sources: [dynamicSource({ kind: 'directory', path: root, include: ['*.mjs'] })],
				state: {
					initial: { autoStart: [address('initial'), address('added')] },
				},
			}),
			{ startup: { root, mode: 'production', env: {}, bindings: {} } },
		)
		expect(requirePluginService(runtime.ctx).isRunning(address('initial'))).toBe(true)
		const service = requirePluginService(runtime.ctx)
		await writeFile(join(root, 'added.mjs'), builtModule('added'))
		await expect.poll(() => service.isRunning(address('added'))).toBe(true)
		await rm(join(root, 'initial.mjs'))
		await expect.poll(() => service.isRunning(address('initial'))).toBe(false)
		await runtime.close()
		await writeFile(join(root, 'after-close.mjs'), builtModule('after-close'))
		expect(service.isRunning(address('added'))).toBe(false)
	} finally {
		await runtime?.close()
		await rm(root, { recursive: true, force: true })
	}
})

it('drains the host after startup rejection even when a source fails to close', async () => {
	const cleanup: string[] = []
	await expect(
		runHostApplication(
			() => ({
				name: 'failed-production-source',
				plugins: [],
				sources: [
					{
						covers: () => false,
						async open() {
							return {
								entries: ['missing-plugin-entry.mjs'],
								async close() {
									cleanup.push('source')
									throw new Error('source close failed')
								},
							}
						},
					},
				],
				state: { mode: 'memory' },
				prepare({ host }) {
					host.ctx.effects.defer(() => {
						cleanup.push('host')
					})
				},
			}),
			{ startup: { root: process.cwd(), mode: 'production', env: {}, bindings: {} } },
		),
	).rejects.toBeInstanceOf(AggregateError)
	expect(cleanup).toEqual(['source', 'host'])
})
