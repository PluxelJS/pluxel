import { describe, expect, it } from 'vitest'

import {
	pluxelRuntimeSourceVitePlugin,
	pluxelRuntimeUiBridgeVitePlugin,
} from '../src/vite'

async function resolveEnvironmentPluginNames(
	plugin: ReturnType<typeof pluxelRuntimeSourceVitePlugin>,
	environment: { name: string; config: { consumer: 'server' | 'client' } },
): Promise<string[]> {
	const applied = await plugin.applyToEnvironment?.(environment as never)
	if (!applied || applied === true) return []
	const plugins = (Array.isArray(applied) ? applied.flat(Number.POSITIVE_INFINITY) : [applied]) as Array<{
		name?: string
	}>
	return plugins.filter(Boolean).map((item) => item.name ?? '')
}

describe('runtime-dev Vite plugin stack', () => {
	it('exposes source/server semantics as a dedicated plugin', () => {
		const plugin = pluxelRuntimeSourceVitePlugin()
		const config = plugin.config?.({} as never, { command: 'serve', mode: 'development' })

		expect(plugin.name).toBe('pluxel:runtime-source')
		expect(config).toMatchObject({
			resolve: {
				conditions: expect.arrayContaining(['@pluxel/source', 'node', 'import', 'default']),
				externalConditions: expect.arrayContaining([
					'@pluxel/source',
					'node',
					'import',
					'default',
				]),
				preserveSymlinks: false,
			},
			environments: {
				ssr: {
					resolve: {
						conditions: expect.arrayContaining([
							'@pluxel/source',
							'node',
							'import',
							'default',
						]),
						externalConditions: expect.arrayContaining([
							'@pluxel/source',
							'node',
							'import',
							'default',
						]),
						preserveSymlinks: false,
					},
				},
			},
			ssr: {
				resolve: {
					conditions: expect.arrayContaining(['@pluxel/source', 'node', 'import', 'default']),
					externalConditions: expect.arrayContaining([
						'@pluxel/source',
						'node',
						'import',
						'default',
					]),
					preserveSymlinks: false,
				},
			},
			oxc: {
				decorator: {
					legacy: true,
				},
			},
		})
	})

	it('exposes UI bridge lowering as a separate plugin', () => {
		const plugin = pluxelRuntimeUiBridgeVitePlugin() as { name?: string }

		expect(plugin.name).toBe('pluxel-runtime-ui-bridge')
	})

	it('expands source transforms only inside server Vite environments', async () => {
		const plugin = pluxelRuntimeSourceVitePlugin({
			root: '/repo',
			serverOnlyName: 'pluxel:test-source-transform',
		})

		await expect(
			resolveEnvironmentPluginNames(plugin, { name: 'ssr', config: { consumer: 'server' } }),
		).resolves.toEqual([
			'pluxel:test-source-transform',
			'pluxel-lint-guard',
			'pluxel-config-source',
		])
		await expect(
			resolveEnvironmentPluginNames(plugin, { name: 'client', config: { consumer: 'client' } }),
		).resolves.toEqual([])
	})
})
