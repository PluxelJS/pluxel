import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { dynamicSource } from '../src/index'

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
	await writeFile(join(path, 'plugin.mjs'), 'export const revision = 1')
	await writeFile(join(path, 'ignored.txt'), 'ignored')
	await expect.poll(() => changes.map((change) => change.type)).toEqual(['add'])
	await writeFile(join(path, 'plugin.mjs'), 'export const revision = 2')
	await expect.poll(() => changes.map((change) => change.type)).toEqual(['add', 'change'])
	await rm(join(path, 'plugin.mjs'))
	await expect.poll(() => changes.map((change) => change.type)).toEqual(['add', 'change', 'unlink'])
	await session.close()
	await writeFile(join(path, 'later.mjs'), 'export {}')
	expect(changes).toHaveLength(3)
	expect(errors).toEqual([])
	const next = await source.open({ root, onChange() {}, onError: (error) => errors.push(error) })
	cleanups.push(() => next.close())
	expect(next.entries).toEqual([join(path, 'later.mjs')])
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
