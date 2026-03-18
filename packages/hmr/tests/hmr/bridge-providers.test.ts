import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { describe, expect, it } from 'vitest'
import { resolveHMRDependencyConfig } from '../../src/dev/hmr/config'

describe('HMR bridgeProviders', () => {
	it('always includes @pluxel/context and maps it to @pluxel/core by default', () => {
		const deps = resolveHMRDependencyConfig()
		expect(deps.bridgeModules.includes('@pluxel/context')).toBe(true)
		expect(deps.bridgeProviders['@pluxel/context']).toBe('@pluxel/core')
	})

	it('auto-maps @pluxel/context -> @pluxel/core when context is not installed', async () => {
		const root = await mkdtemp(join(tmpdir(), 'pluxel-hmr-bridge-providers-'))
		try {
			const pkgRoot = join(root, 'node_modules/@pluxel/core')
			await mkdir(pkgRoot, { recursive: true })
			await writeFile(
				join(pkgRoot, 'package.json'),
				JSON.stringify({ name: '@pluxel/core', version: '0.0.0', main: 'index.js' }, null, 2),
			)
			await writeFile(join(pkgRoot, 'index.js'), 'module.exports = {};\n')

			expect(existsSync(join(root, 'node_modules/@pluxel/core/package.json'))).toBe(true)
			expect(existsSync(join(root, 'node_modules/@pluxel/context/package.json'))).toBe(false)

			const deps = resolveHMRDependencyConfig({ bridgeModules: ['@pluxel/context'] }, { cwd: root })
			expect(deps.bridgeProviders['@pluxel/context']).toBe('@pluxel/core')
			expect(deps.bridgeModules.includes('@pluxel/context')).toBe(true)
			expect(deps.bridgeModules.includes('@pluxel/core')).toBe(true)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('keeps the provider mapping even when @pluxel/context is installed separately', async () => {
		const root = await mkdtemp(join(tmpdir(), 'pluxel-hmr-bridge-providers-'))
		try {
			const coreRoot = join(root, 'node_modules/@pluxel/core')
			await mkdir(coreRoot, { recursive: true })
			await writeFile(
				join(coreRoot, 'package.json'),
				JSON.stringify({ name: '@pluxel/core', version: '0.0.0', main: 'index.js' }, null, 2),
			)
			await writeFile(join(coreRoot, 'index.js'), 'module.exports = {};\n')

			const contextRoot = join(root, 'node_modules/@pluxel/context')
			await mkdir(contextRoot, { recursive: true })
			await writeFile(
				join(contextRoot, 'package.json'),
				JSON.stringify({ name: '@pluxel/context', version: '0.0.0', main: 'index.js' }, null, 2),
			)
			await writeFile(join(contextRoot, 'index.js'), 'module.exports = {};\n')

			expect(existsSync(join(root, 'node_modules/@pluxel/context/package.json'))).toBe(true)

			const deps = resolveHMRDependencyConfig({ bridgeModules: ['@pluxel/context'] }, { cwd: root })
			expect(deps.bridgeProviders['@pluxel/context']).toBe('@pluxel/core')
			expect(deps.bridgeModules.includes('@pluxel/context')).toBe(true)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})
