import type { Context } from '@pluxel/core'
import { createDiskFixture as createFixture } from '@pluxel/test/fixtures'
import { describe, expect, it } from 'vitest'
import { PackageInstaller } from '../../src/package/installer'
import { normalizeSpecifier } from '../../src/package/specifiers'

describe('PackageInstaller', () => {
	it('reads installed package versions directly from node_modules package.json', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({
				name: 'host',
				dependencies: {
					'fixture-pkg': '^1.0.0',
				},
			}),
			'node_modules/fixture-pkg/package.json': JSON.stringify({
				name: 'fixture-pkg',
				version: '1.2.3',
				type: 'module',
				exports: {
					'.': './index.mjs',
				},
			}),
		})

		const installer = new PackageInstaller(
			{} as Context,
			(input) => normalizeSpecifier(input),
			() => {},
			() => {},
		)

		const deps = await installer.readInstalledDependencies({
			options: {
				cwd: fixture.path,
				force: false,
				installPeerDependencies: false,
			},
		})

		expect(deps).toEqual([
			expect.objectContaining({
				installedVersion: '1.2.3',
				requestedVersion: '^1.0.0',
				spec: expect.objectContaining({
					name: 'fixture-pkg',
					version: '1.2.3',
				}),
			}),
		])
	})
})
