import filesystem, { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { pluginSource } from '@pluxel/host/sources'
import { watchPluginSource } from '../src/sources-watch'
import { openPluginSources, type PluginSourceChange } from '../src/source-session'
import { createHostSourceEvaluator } from '../src/application-sources'
import type { ViteDevServer } from 'vite'
import { discoverPluginSources } from '@pluxel/host/internal'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
})

it('validates the completed initial directory without rescanning it for each SDK entry', async () => {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-watch-initial-'))
	cleanups.push(() => rm(root, { recursive: true, force: true }))
	const entries = join(root, 'entries')
	await mkdir(entries)
	const paths = Array.from({ length: 32 }, (_, index) => join(entries, `entry-${index}.mjs`)).sort()
	await Promise.all(paths.map((path) => writeFile(path, 'export {}')))
	const readDirectory = filesystem.readdir
	const scans = vi.spyOn(filesystem, 'readdir')
	syncBuiltinESMExports()
	try {
		const before = process
			.getActiveResourcesInfo()
			.filter((resource) => resource === 'StatWatcher').length
		const source = await watchPluginSource(
			{ kind: 'directory', path: entries, include: ['*.mjs'] },
			{
				root,
				onChange() {},
				onError(error) {
					throw error
				},
			},
		)
		cleanups.push(() => source.close())
		const openingScans = scans.mock.calls.filter(([directory]) => directory === entries).length
		expect(openingScans).toBeGreaterThan(0)
		expect(openingScans).toBeLessThanOrEqual(3)
		expect(await source.entries()).toEqual(paths)
		await source.close()
		expect(
			process.getActiveResourcesInfo().filter((resource) => resource === 'StatWatcher'),
		).toHaveLength(before)
		const target = join(root, 'target.mjs')
		const linked = join(entries, 'linked.mjs')
		await writeFile(target, 'export {}')
		// Publish after initial enumeration but before SDK readiness. The completed
		// observation epoch must still fail, with its original source diagnostic.
		scans.mockImplementationOnce(async (...args) => {
			const listed = await readDirectory(...args)
			await symlink(target, linked)
			return listed
		})
		await expect(
			watchPluginSource(
				{ kind: 'directory', path: entries, include: ['*.mjs'] },
				{ root, onChange() {}, onError() {} },
			),
		).rejects.toMatchObject({ code: 'PLUGIN_SOURCE_SYMLINK', file: linked })
		expect(
			process.getActiveResourcesInfo().filter((resource) => resource === 'StatWatcher'),
		).toHaveLength(before)
	} finally {
		scans.mockRestore()
		syncBuiltinESMExports()
	}
})

it('rejects linked source roots and matching files, closes other opened sources, and permits repair', async () => {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-watch-links-'))
	cleanups.push(() => rm(root, { recursive: true, force: true }))
	const entries = join(root, 'entries')
	await mkdir(entries)
	await writeFile(join(root, 'target.mjs'), 'export {}')
	await symlink(join(root, 'target.mjs'), join(root, 'file.mjs'))
	await symlink(entries, join(root, 'directory'))
	await symlink(join(root, 'target.mjs'), join(entries, 'linked.mjs'))
	await symlink(join(root, 'missing.mjs'), join(entries, 'dangling.mjs'))
	const sources = [
		{ kind: 'file', path: join(root, 'file.mjs') },
		{ kind: 'directory', path: join(root, 'directory'), include: ['*.mjs'] },
		{ kind: 'directory', path: entries, include: ['linked.mjs'] },
		{ kind: 'directory', path: entries, include: ['dangling.mjs'] },
	] as const
	const failures = ['file.mjs', 'directory', 'entries/linked.mjs', 'entries/dangling.mjs']
	const callbacks = { root, onChange() {}, onError() {} }
	for (const [index, source] of sources.entries())
		await expect(watchPluginSource(source, callbacks)).rejects.toMatchObject({
			name: 'TypeError',
			code: 'PLUGIN_SOURCE_SYMLINK',
			file: join(root, failures[index]!),
		})
	const before = process
		.getActiveResourcesInfo()
		.filter((resource) => resource === 'StatWatcher').length
	await expect(
		openPluginSources({
			...callbacks,
			sources: [{ kind: 'file', path: join(root, 'target.mjs') }, sources[0]],
		}),
	).rejects.toMatchObject({ code: 'PLUGIN_SOURCE_SYMLINK', file: join(root, 'file.mjs') })
	expect(
		process.getActiveResourcesInfo().filter((resource) => resource === 'StatWatcher'),
	).toHaveLength(before)
	await rm(join(root, 'file.mjs'))
	await writeFile(join(root, 'file.mjs'), 'export {}')
	const repaired = await watchPluginSource(sources[0], callbacks)
	cleanups.push(() => repaired.close())
	expect(await repaired.entries()).toEqual([join(root, 'file.mjs')])
})

it('uses one physical source owner through parent aliases and ignores nested directory links', async () => {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-watch-alias-'))
	cleanups.push(() => rm(root, { recursive: true, force: true }))
	const physical = join(root, 'physical')
	const entries = join(physical, 'entries')
	const alias = join(root, 'alias')
	await mkdir(entries, { recursive: true })
	await mkdir(join(root, 'outside'))
	const file = join(entries, 'plugin.mjs')
	await writeFile(file, 'export const revision = 1')
	await writeFile(join(root, 'outside', 'ignored.mjs'), 'export {}')
	await symlink(join(root, 'outside'), join(entries, 'nested'))
	await symlink(physical, alias)
	const changes: PluginSourceChange[] = []
	const errors: unknown[] = []
	const session = await openPluginSources({
		root: alias,
		sources: [
			{ kind: 'directory', path: 'entries', include: ['**/*'] },
			{ kind: 'file', path: file },
		],
		onChange: (change) => changes.push(change),
		onError: (error) => errors.push(error),
	})
	cleanups.push(() => session.close())
	expect(await session.entries()).toEqual([file])
	expect(session.covers(file)).toBe(true)
	expect(session.covers(join(alias, 'entries', 'plugin.mjs'))).toBe(true)
	await writeFile(file, 'export const revision = 2')
	await expect.poll(() => changes).toContainEqual({ type: 'change', path: file })
	await rm(file)
	await expect.poll(() => session.entries()).toEqual([])
	expect(changes).toContainEqual({ type: 'unlink', path: file })
	expect(new Set(changes.map((change) => change.path))).toEqual(new Set([file]))
	expect(errors).toEqual([])
	await session.close()
	expect(session.covers(file)).toBe(false)
})

it.each(['existing', 'dangling'] as const)(
	'reports newly published %s links, observes immediate repair and later edits, and drains at close',
	async (kind) => {
		const root = await mkdtemp(join(tmpdir(), 'pluxel-watch-live-link-'))
		cleanups.push(() => rm(root, { recursive: true, force: true }))
		const entries = join(root, 'entries')
		await mkdir(entries)
		const path = join(entries, 'plugin.mjs')
		const target = join(root, kind === 'existing' ? 'target.mjs' : 'missing.mjs')
		const regular = join(root, 'target.mjs')
		await writeFile(regular, 'export {}')
		const changes: PluginSourceChange[] = []
		const errors: unknown[] = []
		const before = process
			.getActiveResourcesInfo()
			.filter((resource) => resource === 'StatWatcher').length
		const session = await openPluginSources({
			root,
			sources: [{ kind: 'directory', path: entries, include: ['*.mjs'] }],
			onChange: (change) => changes.push(change),
			onError: (error) => errors.push(error),
		})
		cleanups.push(() => session.close())
		await symlink(target, path)
		await expect
			.poll(() => errors)
			.toContainEqual(
				expect.objectContaining({
					name: 'TypeError',
					code: 'PLUGIN_SOURCE_SYMLINK',
					file: path,
				}),
			)
		await expect(session.entries()).rejects.toMatchObject({
			code: 'PLUGIN_SOURCE_SYMLINK',
			file: path,
		})
		expect(changes).toEqual([])
		// Repair immediately after the actual failure report; no delay may conceal lost SDK events.
		await rm(path)
		await writeFile(path, 'export const revision = 1')
		await expect.poll(() => session.entries()).toEqual([path])
		expect(changes).toContainEqual({ type: 'add', path })
		const afterRepair = changes.length
		await writeFile(path, 'export const revision = 2')
		await expect.poll(() => changes.slice(afterRepair)).toContainEqual({ type: 'change', path })
		await session.close()
		expect(
			process.getActiveResourcesInfo().filter((resource) => resource === 'StatWatcher'),
		).toHaveLength(before)
		const closed = [...changes]
		const closedErrors = [...errors]
		await rm(path)
		await symlink(target, path)
		const next = await watchPluginSource(
			{ kind: 'file', path: regular },
			{ root, onChange() {}, onError() {} },
		)
		cleanups.push(() => next.close())
		expect(changes).toEqual(closed)
		expect(errors).toEqual(closedErrors)
	},
)

it.each(['existing', 'missing'] as const)(
	'reports a linked %s directory root and continues observing its regular replacement',
	async (kind) => {
		const root = await mkdtemp(join(tmpdir(), 'pluxel-watch-live-root-'))
		cleanups.push(() => rm(root, { recursive: true, force: true }))
		const path = join(root, 'entries')
		const target = join(root, 'target')
		if (kind === 'existing') await mkdir(path)
		await mkdir(target)
		await writeFile(join(target, 'foreign.mjs'), 'export {}')
		const errors: unknown[] = []
		const session = await openPluginSources({
			root,
			sources: [{ kind: 'directory', path, include: ['*.mjs'] }],
			onChange() {},
			onError: (error) => errors.push(error),
		})
		cleanups.push(() => session.close())
		await rm(path, { recursive: true, force: true })
		await symlink(target, path)
		await expect
			.poll(() => errors)
			.toContainEqual(
				expect.objectContaining({
					code: 'PLUGIN_SOURCE_SYMLINK',
					file: path,
				}),
			)
		await expect(session.entries()).rejects.toMatchObject({
			code: 'PLUGIN_SOURCE_SYMLINK',
			file: path,
		})
		await rm(path)
		await mkdir(path)
		const file = join(path, 'repaired.mjs')
		await writeFile(file, 'export {}')
		await expect.poll(() => session.entries()).toEqual([file])
		const later = join(path, 'second.mjs')
		await writeFile(later, 'export {}')
		await expect.poll(() => session.entries()).toEqual([file, later])
	},
)

it('retains an explicit file while a link replaces it and observes its immediate regular repair', async () => {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-watch-live-file-'))
	cleanups.push(() => rm(root, { recursive: true, force: true }))
	const path = join(root, 'plugin.mjs')
	const target = join(root, 'target.mjs')
	await writeFile(path, 'export const revision = 0')
	await writeFile(target, 'export {}')
	const changes: PluginSourceChange[] = []
	const errors: unknown[] = []
	const session = await openPluginSources({
		root,
		sources: [{ kind: 'file', path }],
		onChange: (change) => changes.push(change),
		onError: (error) => errors.push(error),
	})
	cleanups.push(() => session.close())
	await rm(path)
	await symlink(target, path)
	await expect
		.poll(() => errors)
		.toContainEqual(expect.objectContaining({ code: 'PLUGIN_SOURCE_SYMLINK', file: path }))
	await expect(session.entries()).rejects.toMatchObject({
		code: 'PLUGIN_SOURCE_SYMLINK',
		file: path,
	})
	expect(changes).toEqual([])
	await rm(path)
	await writeFile(path, 'export const revision = 1')
	await expect.poll(() => changes).toContainEqual({ type: 'change', path })
	const repaired = changes.length
	await writeFile(path, 'export const revision = 2')
	await expect.poll(() => changes.slice(repaired)).toContainEqual({ type: 'change', path })
})

it('discovers initial and later publications, filters unrelated files, and stops at close', async () => {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-source-'))
	cleanups.push(() => rm(root, { recursive: true, force: true }))
	const path = join(root, 'managed', 'entries')
	const source = pluginSource({ kind: 'directory', path, include: ['*.mjs'] })
	const changes: { type: string; path: string }[] = []
	const errors: unknown[] = []
	const session = await watchPluginSource(source, {
		root,
		onChange: (change) => changes.push(change),
		onError: (error) => errors.push(error),
	})
	cleanups.push(() => session.close())
	expect(await session.entries()).toEqual([])
	await mkdir(path, { recursive: true })
	const pluginPath = join(path, 'plugin.mjs')
	await writeFile(pluginPath, 'export const revision = 1')
	await writeFile(join(path, 'ignored.txt'), 'ignored')
	await expect.poll(() => changes).toContainEqual({ type: 'add', path: pluginPath })
	// A filesystem write may produce multiple notifications. Each phase must be
	// observed, without treating the watcher as an exactly-once event stream.
	const beforeChange = changes.length
	await writeFile(pluginPath, 'export const revision = 2')
	await expect
		.poll(() => changes.slice(beforeChange))
		.toContainEqual({ type: 'change', path: pluginPath })
	const beforeUnlink = changes.length
	await rm(pluginPath)
	await expect
		.poll(() => changes.slice(beforeUnlink))
		.toContainEqual({ type: 'unlink', path: pluginPath })
	expect(new Set(changes.map((change) => change.path))).toEqual(new Set([pluginPath]))
	await session.close()
	const closedChanges = [...changes]
	await writeFile(join(path, 'later.mjs'), 'export {}')
	const next = await watchPluginSource(source, {
		root,
		onChange() {},
		onError: (error) => errors.push(error),
	})
	cleanups.push(() => next.close())
	expect(await next.entries()).toEqual([join(path, 'later.mjs')])
	// Opening waits for discovery readiness, so the post-close write has crossed
	// the filesystem watcher boundary before checking the old session's admission.
	expect(changes).toEqual(closedChanges)
	expect(errors).toEqual([])
})

it('rejects application reevaluation while a declared source remains invalid and accepts immediate repair', async () => {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-evaluator-source-link-'))
	cleanups.push(() => rm(root, { recursive: true, force: true }))
	const entries = join(root, 'entries')
	await mkdir(entries)
	const file = join(entries, 'invalid.mjs')
	const target = join(root, 'target.mjs')
	await writeFile(target, 'export {}')
	const errors: unknown[] = []
	const evaluator = createHostSourceEvaluator({
		root,
		server: {} as ViteDevServer,
		onChange() {},
		onError: (error) => errors.push(error),
	})
	cleanups.push(() => evaluator.close())
	const evaluate = () =>
		evaluator.evaluate({
			application: {
				plugins: [],
				sources: [{ kind: 'directory', path: entries, include: ['*.mjs'] } as const],
			},
			entryFiles: new Set<string>(),
		})
	const initial = await evaluate()
	await initial.accept()
	await symlink(target, file)
	await expect
		.poll(() => errors)
		.toContainEqual(expect.objectContaining({ code: 'PLUGIN_SOURCE_SYMLINK', file }))
	await expect(evaluate()).rejects.toMatchObject({ code: 'PLUGIN_SOURCE_SYMLINK', file })
	// Removing the bad publication repairs the empty source without replacing its watcher.
	await rm(file)
	const repaired = await evaluate()
	expect(repaired.application.plugins).toEqual([])
	expect(repaired.declarationsChanged).toBe(false)
	await repaired.accept()
})

it('rejects a new alias in initially missing source ancestry and restores its fixed physical owner', async () => {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-watch-late-parent-alias-'))
	cleanups.push(() => rm(root, { recursive: true, force: true }))
	const parent = join(root, 'managed')
	const path = join(parent, 'entries')
	const target = join(root, 'target')
	const foreign = join(target, 'entries', 'plugin.mjs')
	await mkdir(join(target, 'entries'), { recursive: true })
	await mkdir(join(root, 'node_modules/@pluxel'), { recursive: true })
	await symlink(
		fileURLToPath(new URL('../../core', import.meta.url)),
		join(root, 'node_modules/@pluxel/core'),
		'dir',
	)
	await writeFile(
		foreign,
		`import { BasePlugin, Plugin } from '@pluxel/core';
import { __setPluginDefinition } from '@pluxel/core/toolchain';
export class Foreign extends BasePlugin {}
Plugin()(Foreign);
__setPluginDefinition(Foreign, { abiVersion: 2, kind: 'plugin', definition: { entry: { kind: 'source-entry', sourceSpace: 'fixture', path: 'foreign.mjs' }, exportName: 'Foreign' } });`,
	)
	const source = { kind: 'directory', path, include: ['*.mjs'] } as const
	const errors: unknown[] = []
	const changes: PluginSourceChange[] = []
	const before = process
		.getActiveResourcesInfo()
		.filter((resource) => resource === 'StatWatcher').length
	const session = await watchPluginSource(source, {
		root,
		onChange: (change) => changes.push(change),
		onError: (error) => errors.push(error),
	})
	cleanups.push(() => session.close())
	const evaluator = createHostSourceEvaluator({
		root,
		server: {} as ViteDevServer,
		onChange() {},
		onError: (error) => errors.push(error),
	})
	cleanups.push(() => evaluator.close())
	const evaluate = () =>
		evaluator.evaluate({
			application: { plugins: [], sources: [source] },
			entryFiles: new Set<string>(),
		})
	const initial = await evaluate()
	await initial.accept()
	await symlink(target, parent)
	// A fresh opening can resolve an existing parent alias. The earlier watcher owns its captured path.
	expect(await discoverPluginSources({ root, sources: [source] })).toEqual([foreign])
	const rebound = await Promise.allSettled([session.entries(), evaluate()])
	expect(rebound).toMatchObject([
		{ status: 'rejected', reason: { code: 'PLUGIN_SOURCE_PATH_CHANGED', file: path } },
		{ status: 'rejected', reason: { code: 'PLUGIN_SOURCE_PATH_CHANGED', file: path } },
	])
	await expect
		.poll(() => errors)
		.toContainEqual(expect.objectContaining({ code: 'PLUGIN_SOURCE_PATH_CHANGED', file: path }))
	await rm(parent)
	await mkdir(path, { recursive: true })
	const repaired = await evaluate()
	expect(repaired.application.plugins).toEqual([])
	expect(repaired.declarationsChanged).toBe(false)
	await repaired.accept()
	expect(await session.entries()).toEqual([])
	const file = join(path, 'regular.mjs')
	await writeFile(file, 'export const revision = 1')
	await expect.poll(() => session.entries()).toEqual([file])
	expect(changes).toContainEqual({ type: 'add', path: file })
	const published = changes.length
	await writeFile(file, 'export const revision = 2')
	await expect.poll(() => changes.slice(published)).toContainEqual({ type: 'change', path: file })
	await session.close()
	await evaluator.close()
	expect(
		process.getActiveResourcesInfo().filter((resource) => resource === 'StatWatcher'),
	).toHaveLength(before)
})
