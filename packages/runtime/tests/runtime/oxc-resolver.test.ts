import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
	clearOxcResolveCache,
	getCachedResolver,
	getOxcResolveCache,
	resolvePackageJsonPathWithOxc,
	resolveModulePath,
	toDirectoryURLString,
} from '@pluxel/runtime/internal'

describe('runtime/shared OXC resolver helpers', () => {
	it('normalizes backslashes and enforces a trailing slash', () => {
		const cases =
			process.platform === 'win32'
				? [
						['C:\\\\tmp\\\\a\\\\b', 'file:///C:/tmp/a/b/'],
						['C:/tmp/a/b', 'file:///C:/tmp/a/b/'],
						['C:/tmp/a/b/', 'file:///C:/tmp/a/b/'],
					]
				: [
						['/tmp\\\\a\\\\b', 'file:///tmp/a/b/'],
						['/tmp/a/b', 'file:///tmp/a/b/'],
						['/tmp/a/b/', 'file:///tmp/a/b/'],
					]

		expect(cases.map(([input]) => toDirectoryURLString(input))).toEqual(
			cases.map(([, expected]) => expected),
		)
	})

	it('resolves package export maps through the shared OXC resolver', async () => {
		const root = join(tmpdir(), `pluxel-runtime-oxc-resolver-${process.pid}-${Date.now()}`)
		const pkgRoot = join(root, 'node_modules', 'shared-resolver-fixture')
		await mkdir(pkgRoot, { recursive: true })
		await writeFile(
			join(pkgRoot, 'package.json'),
			JSON.stringify({
				name: 'shared-resolver-fixture',
				type: 'module',
				exports: {
					'.': {
						import: './esm.mjs',
						require: './cjs.cjs',
					},
				},
			}),
		)
		await writeFile(join(pkgRoot, 'esm.mjs'), 'export const value = 1\n')
		await writeFile(join(pkgRoot, 'cjs.cjs'), 'module.exports = { value: 1 }\n')

		const cache = getOxcResolveCache(new Map())
		const resolver = getCachedResolver(cache, 'test:shared-resolver', [root])

		expect(
			resolveModulePath(resolver, 'shared-resolver-fixture', {
				conditions: ['node', 'import', 'default'],
			}),
		).toBe(join(pkgRoot, 'esm.mjs'))
		expect(
			resolveModulePath(resolver, 'shared-resolver-fixture', {
				conditions: ['node', 'require', 'default'],
			}),
		).toBe(join(pkgRoot, 'cjs.cjs'))
		expect(
			resolvePackageJsonPathWithOxc(resolver, 'shared-resolver-fixture', {
				conditions: ['node', 'import', 'default'],
			}),
		).toBe(join(pkgRoot, 'package.json'))
	})

	it('keys resolver cache by normalized directories and honors clearOxcResolveCache()', async () => {
		const root = join(tmpdir(), `pluxel-runtime-oxc-cache-${process.pid}-${Date.now()}`)
		await mkdir(root, { recursive: true })

		const cache = getOxcResolveCache(new Map())
		const first = getCachedResolver(cache, 'test:cache', [root])
		const sameDirectoryUrl = getCachedResolver(cache, 'test:cache', [toDirectoryURLString(root)])
		expect(sameDirectoryUrl).toBe(first)

		clearOxcResolveCache(cache)

		const next = getCachedResolver(cache, 'test:cache', [root])
		expect(next).not.toBe(first)
	})
})
