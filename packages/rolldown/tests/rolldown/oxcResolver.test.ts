import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolvePackageJsonPathWithOxc } from '../../src/resolver/oxc'

describe('resolvePackageJsonPathWithOxc', () => {
	it('uses package entry metadata when package.json is not exported', async () => {
		const root = join(tmpdir(), `pluxel-oxc-resolver-${process.pid}-${Date.now()}`)
		const pkgRoot = join(root, 'node_modules', 'fixture-pkg')
		await mkdir(pkgRoot, { recursive: true })
		await writeFile(
			join(pkgRoot, 'package.json'),
			JSON.stringify({
				name: 'fixture-pkg',
				version: '1.2.3',
				exports: {
					'.': './index.js',
				},
			}),
		)
		await writeFile(join(pkgRoot, 'index.js'), 'export const value = 1\n')

		expect(resolvePackageJsonPathWithOxc(root, 'fixture-pkg')).toBe(join(pkgRoot, 'package.json'))
	})
})
