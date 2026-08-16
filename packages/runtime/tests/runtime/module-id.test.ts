import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
	findRuntimeModuleId,
	resolveModuleIdBaseDir,
	resolveModuleIdPath,
} from '../../src/runtime/module-id'

describe('runtime module id lookup', () => {
	it('uses the Core node slot ownership index without a name fallback', () => {
		const pluginA = {
			definition: {
				entry: { kind: 'package-root', packageName: '@test/a' },
				exportName: 'Plugin',
			},
			instance: 'default',
		} as const
		const pluginB = {
			definition: {
				entry: { kind: 'package-root', packageName: '@test/b' },
				exportName: 'Plugin',
			},
			instance: 'default',
		} as const
		const nodeA = { owner: pluginA }
		const nodeB = { owner: pluginB }
		const ctx = {
			registry: {
				internNodeAddress: (owner: typeof pluginA | typeof pluginB) =>
					(owner === pluginA ? nodeA : nodeB) as never,
				getRuntimeModuleId: (node: never) =>
					(node as unknown) === nodeA ? '/core/PluginA.ts' : undefined,
			},
		}

		expect(findRuntimeModuleId(ctx, pluginA)).toBe('/core/PluginA.ts')
		expect(findRuntimeModuleId(ctx, pluginB)).toBeNull()
	})

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
