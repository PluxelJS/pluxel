import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { pluginSource } from '../../src/sources'
import { pluginSourceCovers } from '../../src/source-contract'
import { discoverPluginSources } from '../../src/source-discovery'

it('snapshots declarations and rejects traversal before opening IO', () => {
	const include = ['*.mjs']
	const source = pluginSource({ kind: 'directory', path: 'entries', include })
	include.push('*.js')
	expect(
		pluginSourceCovers({
			source,
			root: '/app',
			requirement: { kind: 'file', path: '/app/entries/plugin.mjs' },
		}),
	).toBe(true)
	expect(
		pluginSourceCovers({
			source,
			root: '/app',
			requirement: { kind: 'file', path: '/app/entries/plugin.js' },
		}),
	).toBe(false)
	expect(() => pluginSource({ kind: 'directory', path: 'entries', include: ['../*.mjs'] })).toThrow(
		'must stay inside their directory',
	)
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
			{ kind: 'file', path: join(root, 'file.mjs') },
			{ kind: 'directory', path: join(root, 'directory'), include: ['*.mjs'] },
			{ kind: 'directory', path: entries, include: ['linked.mjs'] },
			{ kind: 'directory', path: entries, include: ['dangling.mjs'] },
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
				{ kind: 'directory', path: join(alias, 'entries'), include: ['**/*'] },
				{ kind: 'file', path: join(entries, 'plugin.mjs') },
			],
		})
		expect(files).toEqual([join(entries, 'plugin.mjs')])
		expect(
			await discoverPluginSources({
				root: alias,
				sources: [{ kind: 'directory', path: 'entries', include: ['**/*'] }],
			}),
		).toEqual(files)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
