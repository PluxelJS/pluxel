import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { pluginSourceCovers, snapshotPluginSource } from '../../src/source-contract'
import { discoverPluginSources } from '../../src/source-discovery'

it('snapshots declarations and rejects traversal before opening IO', () => {
	const include = ['*.mjs']
	const source = snapshotPluginSource({ directory: 'entries', include })
	include.push('*.js')
	expect(
		pluginSourceCovers({
			source,
			root: '/app',
			requirement: { file: '/app/entries/plugin.mjs' },
		}),
	).toBe(true)
	expect(
		pluginSourceCovers({
			source,
			root: '/app',
			requirement: { file: '/app/entries/plugin.js' },
		}),
	).toBe(false)
	expect(() => snapshotPluginSource({ directory: 'entries', include: ['../*.mjs'] })).toThrow(
		'must stay inside their directory',
	)
})

it.each([
	[{ file: './feed.mjs', directory: './feed', include: ['*.mjs'] }, 'exactly one'],
	[{ file: './feed.mjs', include: ['*.mjs'] }, 'unsupported "include"'],
	[{ directory: './feed', include: [] }, 'must be a non-empty array'],
])('rejects invalid source %j before discovery', (source, message) => {
	expect(() => snapshotPluginSource(source)).toThrow(message)
})

it('rejects explicit and matching file links, including dangling links, before admitting entries', async () => {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-source-links-'))
	try {
		const entries = join(root, 'entries')
		await mkdir(entries)
		await writeFile(join(root, 'target.mjs'), 'export {}')
		await symlink(join(root, 'target.mjs'), join(root, 'file.mjs'))
		await symlink(entries, join(root, 'directory'))
		await symlink(join(root, 'target.mjs'), join(entries, 'linked.mjs'))
		await symlink(join(root, 'missing.mjs'), join(entries, 'dangling.mjs'))
		const cases = [
			{ file: join(root, 'file.mjs') },
			{ directory: join(root, 'directory'), include: ['*.mjs'] },
			{ directory: entries, include: ['linked.mjs'] },
			{ directory: entries, include: ['dangling.mjs'] },
		] as const
		const failures = ['file.mjs', 'directory', 'entries/linked.mjs', 'entries/dangling.mjs']
		for (const [index, source] of cases.entries())
			await expect(discoverPluginSources({ root, sources: [source] })).rejects.toMatchObject({
				name: 'TypeError',
				code: 'PLUGIN_SOURCE_SYMLINK',
				file: join(root, failures[index]!),
			})
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

it('resolves parent aliases, deduplicates physical files, and never traverses nested directory links', async () => {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-source-alias-'))
	try {
		const parent = join(root, 'physical')
		const entries = join(parent, 'entries')
		const alias = join(root, 'alias')
		await mkdir(entries, { recursive: true })
		await mkdir(join(root, 'outside'))
		await writeFile(join(entries, 'plugin.mjs'), 'export {}')
		await writeFile(join(root, 'outside', 'ignored.mjs'), 'export {}')
		await symlink(join(root, 'outside'), join(entries, 'nested'))
		await symlink(parent, alias)
		const files = await discoverPluginSources({
			root,
			sources: [
				{ directory: join(alias, 'entries'), include: ['**/*'] },
				{ file: join(entries, 'plugin.mjs') },
			],
		})
		expect(files).toEqual([join(entries, 'plugin.mjs')])
		expect(
			await discoverPluginSources({
				root: alias,
				sources: [{ directory: 'entries', include: ['**/*'] }],
			}),
		).toEqual(files)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
