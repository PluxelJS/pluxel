import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { dynamicSource } from '../../src/dynamic/index'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
})

it('discovers initial and later publications, filters unrelated files, and stops at close', async () => {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-source-'))
	cleanups.push(() => rm(root, { recursive: true, force: true }))
	const path = join(root, 'managed', 'entries')
	const source = dynamicSource({ kind: 'directory', path, include: ['*.mjs'] })
	const changes: { type: string; path: string }[] = []
	const errors: unknown[] = []
	const session = await source.open({
		root,
		onChange: (change) => changes.push(change),
		onError: (error) => errors.push(error),
	})
	cleanups.push(() => session.close())
	expect(session.entries).toEqual([])
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
	const next = await source.open({ root, onChange() {}, onError: (error) => errors.push(error) })
	cleanups.push(() => next.close())
	expect(next.entries).toEqual([join(path, 'later.mjs')])
	// Opening waits for discovery readiness, so the post-close write has crossed
	// the filesystem watcher boundary before checking the old session's admission.
	expect(changes).toEqual(closedChanges)
	expect(errors).toEqual([])
})

it('snapshots declarations and rejects traversal before opening IO', () => {
	const include = ['*.mjs']
	const source = dynamicSource({ kind: 'directory', path: 'entries', include })
	include.push('*.js')
	expect(
		source.covers({ root: '/app', requirement: { kind: 'file', path: '/app/entries/plugin.mjs' } }),
	).toBe(true)
	expect(
		source.covers({ root: '/app', requirement: { kind: 'file', path: '/app/entries/plugin.js' } }),
	).toBe(false)
	expect(() =>
		dynamicSource({ kind: 'directory', path: 'entries', include: ['../*.mjs'] }),
	).toThrow('must stay inside their directory')
})
