import { mkdir, mkdtemp, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readLocalPackage } from '../src/local-package.ts'

it('reads local docs without a registry and follows the dependency from its actual issuer', async () => {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-pkg-docs-'))
	const plugin = join(root, 'node_modules', '@org', 'local')
	async function manifest(dir: string, value: object) {
		await mkdir(dir, { recursive: true })
		await writeFile(join(dir, 'package.json'), JSON.stringify(value))
	}
	try {
		await manifest(root, { name: 'app', dependencies: { '@org/local': '*' } })
		await manifest(plugin, {
			name: '@org/local',
			version: '1.0.0',
			peerDependencies: { codec: '^1', addon: '*' },
			peerDependenciesMeta: { addon: { optional: true } },
			pluxel: { pluginPackages: { codec: 'required', addon: 'optional' } },
		})
		await writeFile(join(plugin, 'ReadMe.md'), '# Local docs')
		await manifest(join(root, 'node_modules', 'codec'), { name: 'codec', version: '2.0.0' })
		const nested = join(plugin, 'node_modules', 'codec')
		await manifest(nested, { name: 'codec', version: '1.2.0' })
		await symlink(join(root, 'package.json'), join(nested, 'README.md'))
		const sources = [{ name: '@org/local', packageRoot: plugin }]
		for (const source of ['managed', 'application'] as const) {
			const read = (...path: string[]) => readLocalPackage({ source, path }, root, sources)
			expect(await read('@org/local')).toMatchObject({
				name: '@org/local',
				version: '1.0.0',
				readme: { text: '# Local docs' },
				dependencies: [
					{ name: 'addon', kind: 'optional peer', plugin: 'optional' },
					{ name: 'codec', range: '^1', plugin: 'required' },
				],
			})
			expect(await read('@org/local', 'codec')).toMatchObject({ version: '1.2.0', readme: null })
			expect(await read('@org/local', 'addon')).toBeNull()
			expect(await read('@org/local', 'unrelated')).toBeNull()
			await expect(read('../package.json')).rejects.toThrow('package names')
		}
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
