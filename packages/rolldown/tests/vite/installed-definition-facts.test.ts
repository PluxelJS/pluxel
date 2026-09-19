import { createFixture } from 'fs-fixture'
import { createServer } from 'vite'
import { expect, it } from 'vitest'
import { pluginDefinitionIndexKey } from '@pluxel/core'
import { PLUGIN_LOWERING_ABI_VERSION } from '@pluxel/core/toolchain'
import { createPluginSourceVitePipeline } from '../../src/vite/plugin-source'

it('observes compiled ABI facts in physical installed packages without lowering their raw source', async () => {
	const definition = {
		entry: { kind: 'package-root', packageName: '@fixture/installed' },
		exportName: 'Built',
	} as const
	await using fixture = await createFixture({
		'package.json': JSON.stringify({ name: 'installed-facts-fixture', type: 'module' }),
		'node_modules/@fixture/installed/package.json': JSON.stringify({
			name: '@fixture/installed',
			type: 'module',
			exports: './index.mjs',
		}),
		'node_modules/@fixture/installed/index.mjs': `import { __setPluginDefinition } from '@pluxel/core/toolchain';
export class Built {};
__setPluginDefinition(Built, ${JSON.stringify({ abiVersion: PLUGIN_LOWERING_ABI_VERSION, kind: 'plugin', definition })});`,
		'node_modules/@fixture/installed/raw.ts': `import { BasePlugin, Plugin } from '@pluxel/core';
@Plugin() export class Raw extends BasePlugin {}`,
		'node_modules/@pluxel/core/package.json': JSON.stringify({
			name: '@pluxel/core',
			type: 'module',
			exports: { '.': './index.mjs', './toolchain': './toolchain.mjs' },
		}),
		'node_modules/@pluxel/core/index.mjs':
			'export class BasePlugin {}; export const Plugin = () => (plugin) => plugin;',
		'node_modules/@pluxel/core/toolchain.mjs': 'export const __setPluginDefinition = () => {};',
	})
	const pipeline = createPluginSourceVitePipeline({
		root: fixture.path,
		lintGuard: false,
		configSource: false,
	})
	const server = await createServer({
		root: fixture.path,
		configFile: false,
		logLevel: 'silent',
		server: { middlewareMode: true },
		appType: 'custom',
		environments: { other: { consumer: 'server' } },
		plugins: [...pipeline.plugins],
	})
	try {
		const builtPath = fixture.getPath('node_modules/@fixture/installed/index.mjs')
		await server.environments.other.transformRequest(builtPath)
		expect(pipeline.semantics.builtDefinitionModules([builtPath]).size).toBe(0)
		await server.environments.ssr.transformRequest(builtPath)
		expect(pipeline.semantics.classifyDefinitionArtifact(definition, [builtPath])).toBe(
			'built-module',
		)
		expect(pipeline.semantics.builtDefinitionModules([builtPath]).get(builtPath)).toEqual(
			new Set([pluginDefinitionIndexKey(definition)]),
		)
		const raw = await server.environments.ssr.transformRequest(
			fixture.getPath('node_modules/@fixture/installed/raw.ts'),
		)
		expect(raw?.code).not.toContain('__setPluginDefinition')
		expect(pipeline.semantics.definitions()).toEqual([])
		expect(pipeline.semantics.builtDefinitionModules([]).size).toBe(0)
	} finally {
		await server.close()
	}
})
