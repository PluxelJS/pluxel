import { describe, expect, it } from 'vitest'

import { createPluginBuildPipeline, pluginPackage } from '../src/cli/plugin-build.ts'
import { staticApplication } from '../src/cli/static-application.ts'

function pluginNames(config: ReturnType<typeof staticApplication>): string[] {
	return (config.plugins as Array<{ name?: string } | null | undefined>)
		.filter((plugin): plugin is { name?: string } => Boolean(plugin))
		.map((plugin) => plugin.name ?? '')
}

describe('staticApplication', () => {
	it('exposes one standard plugin package preset and shared source pipeline', () => {
		const pipeline = createPluginBuildPipeline({ root: '/tmp/pluxel-plugin-package' })
		const config = pluginPackage({ root: '/tmp/pluxel-plugin-package' })

		expect(pluginNames(config)).toEqual(pluginNames(pipeline))
		expect(pluginNames(config)).toEqual([
			'unplugin-preprocessor-directives',
			'unplugin-macros',
			'pluxel-lint-guard',
			'pluxel-config-source',
			'pluxel-workbench-ui-build',
			'pluxel:decorator-output-guard',
		])
		expect(config.deps?.neverBundle).toEqual([/^@pluxel\//])
		expect(config.inputOptions?.transform?.decorator).toEqual({
			legacy: true,
			emitDecoratorMetadata: true,
		})
	})

	it('builds Node applications with native residual tracing', () => {
		const config = staticApplication({
			cwd: '/tmp/pluxel-static-node',
			entry: './src/pluxel.static.ts',
			variant: 'headless',
			target: 'node',
			lint: false,
		})

		expect(config.platform).toBe('node')
		expect(config.target).toBe('node24')
		expect(pluginNames(config)).toContain('pluxel:nf3-externals')
		expect(pluginNames(config)).toContain('pluxel:decorator-output-guard')
		expect(config.inputOptions?.transform?.decorator).toEqual({
			legacy: true,
			emitDecoratorMetadata: true,
		})
	})

	it('rejects unsupported platform targets instead of emitting incomplete bundles', () => {
		expect(() =>
			staticApplication({
				entry: './src/pluxel.static.ts',
				variant: 'headless',
				target: 'fetch' as never,
			}),
		).toThrow('only the node target is currently supported')
	})

	it('keeps production bootstrap imports inside the directly installed route package', async () => {
		const source = await import('node:fs/promises').then(({ readFile }) =>
			readFile(new URL('../src/cli/static-application.ts', import.meta.url), 'utf8'),
		)

		expect(source).not.toContain("from '@pluxel/runtime/internal/static'")
		expect(source).toContain('@pluxel/runtime-static/internal/node-workbench-application')
		expect(source).toContain('runStaticNodeWorkbenchApplication')
	})
})
