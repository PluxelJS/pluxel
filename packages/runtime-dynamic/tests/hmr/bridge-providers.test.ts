import { join } from 'pathe'
import { describe, expect, it } from 'vitest'
import { createDiskFixture as createFixture } from '@pluxel/test/fixtures'
import { resolveLoaderHmrDependencyConfig } from '../../src/hmr/engine/config'

describe('HMR bridgeProviders', () => {
	it('always includes @pluxel/context and maps it to @pluxel/core by default', () => {
		const deps = resolveLoaderHmrDependencyConfig()
		expect(deps.bridgeModules.includes('@pluxel/context')).toBe(true)
		expect(deps.bridgeModules.includes('@pluxel/runtime/internal')).toBe(true)
		expect(deps.bridgeProviders['@pluxel/context']).toBe('@pluxel/core')
	})

	it('auto-maps @pluxel/context -> @pluxel/core when context is not installed', async () => {
		await using fixture = await createFixture({
			'node_modules/@pluxel/core/package.json': JSON.stringify(
				{ name: '@pluxel/core', version: '0.0.0', main: 'index.js' },
				null,
				2,
			),
			'node_modules/@pluxel/core/index.js': 'module.exports = {};\n',
		})
		const root = fixture.path

		expect(fixture.fs.existsSync(join(root, 'node_modules/@pluxel/core/package.json'))).toBe(true)
		expect(fixture.fs.existsSync(join(root, 'node_modules/@pluxel/context/package.json'))).toBe(
			false,
		)

		const deps = resolveLoaderHmrDependencyConfig(
			{ bridgeModules: ['@pluxel/context'] },
			{ cwd: root },
		)
		expect(deps.bridgeProviders['@pluxel/context']).toBe('@pluxel/core')
		expect(deps.bridgeModules.includes('@pluxel/context')).toBe(true)
		expect(deps.bridgeModules.includes('@pluxel/core')).toBe(true)
	})

	it('keeps the provider mapping even when @pluxel/context is installed separately', async () => {
		await using fixture = await createFixture({
			'node_modules/@pluxel/core/package.json': JSON.stringify(
				{ name: '@pluxel/core', version: '0.0.0', main: 'index.js' },
				null,
				2,
			),
			'node_modules/@pluxel/core/index.js': 'module.exports = {};\n',
			'node_modules/@pluxel/context/package.json': JSON.stringify(
				{ name: '@pluxel/context', version: '0.0.0', main: 'index.js' },
				null,
				2,
			),
			'node_modules/@pluxel/context/index.js': 'module.exports = {};\n',
		})
		const root = fixture.path

		expect(fixture.fs.existsSync(join(root, 'node_modules/@pluxel/context/package.json'))).toBe(
			true,
		)

		const deps = resolveLoaderHmrDependencyConfig(
			{ bridgeModules: ['@pluxel/context'] },
			{ cwd: root },
		)
		expect(deps.bridgeProviders['@pluxel/context']).toBe('@pluxel/core')
		expect(deps.bridgeModules.includes('@pluxel/context')).toBe(true)
	})
})
