import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { resolveModuleIdBaseDir, resolveModuleIdPath } from '../../src/runtime/module-id'

describe('runtime module id lookup', () => {
	it('resolves runtime module ids with OXC resolver from cwd', async () => {
		const root = join(tmpdir(), `pluxel-runtime-module-id-${process.pid}-${Date.now()}`)
		const pkgDir = join(root, 'node_modules', 'runtime-fixture')
		await mkdir(pkgDir, { recursive: true })
		await writeFile(
			join(pkgDir, 'package.json'),
			JSON.stringify({
				name: 'runtime-fixture',
				type: 'module',
				exports: {
					'.': './index.mjs',
				},
			}),
		)
		await writeFile(join(pkgDir, 'index.mjs'), 'export const value = 1\n')

		expect(resolveModuleIdPath('runtime-fixture', root)).toBe(join(pkgDir, 'index.mjs'))
		expect(resolveModuleIdBaseDir('runtime-fixture', root)).toBe(pkgDir)
	})
})
