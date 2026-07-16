import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
	hasNodeModulesPackageJson,
	installedPackageJsonPath,
	nodeModulesPackageJsonPath,
	toBasePackage,
} from '@pluxel/runtime/internal'

describe('runtime/shared node_modules helpers', () => {
	it('normalizes package specifiers to their install root', () => {
		expect(toBasePackage('react/jsx-runtime')).toBe('react')
		expect(toBasePackage('@scope/pkg/subpath')).toBe('@scope/pkg')
		expect(toBasePackage('@scope')).toBe('@scope')
	})

	it('builds direct node_modules package.json paths', () => {
		const nodeModules = join('/workspace', 'node_modules')

		expect(nodeModulesPackageJsonPath(nodeModules, 'react/jsx-runtime')).toBe(
			join(nodeModules, 'react', 'package.json'),
		)
		expect(nodeModulesPackageJsonPath(nodeModules, '@scope/pkg/subpath')).toBe(
			join(nodeModules, '@scope', 'pkg', 'package.json'),
		)
		expect(nodeModulesPackageJsonPath(nodeModules, '@scope')).toBe(null)
		expect(installedPackageJsonPath('/workspace', '@scope/pkg')).toBe(
			join('/workspace', 'node_modules', '@scope', 'pkg', 'package.json'),
		)
	})

	it('checks only direct node_modules package.json entries', async () => {
		const root = join(tmpdir(), `pluxel-node-modules-${process.pid}-${Date.now()}`)
		const nodeModules = join(root, 'node_modules')
		await mkdir(join(nodeModules, '@scope', 'pkg'), { recursive: true })
		await writeFile(join(nodeModules, '@scope', 'pkg', 'package.json'), '{"name":"@scope/pkg"}')

		expect(hasNodeModulesPackageJson(nodeModules, '@scope/pkg/subpath')).toBe(true)
		expect(hasNodeModulesPackageJson(nodeModules, '@scope/missing')).toBe(false)
	})
})
