import * as nativeFs from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BasePlugin, Plugin, type PluginConstructor } from '@pluxel/core'
import { createStore, type Store } from 'tinybase'
import { createQueries } from 'tinybase/queries'
import { afterEach, expect, it, vi } from 'vitest'
import { createCoreTestHost, getCoreTestHostContext } from '../src/internal-test'
import { Passthrough } from '../src/fs'
import { pluginNodePhysicalKey } from '../src/internal/plugin-address'
import { requireFs, requireTinyBaseHost } from '../src/internal/storage'

@Plugin()
class SharedState extends BasePlugin {
	readonly state = this.ctx.tinybase
	store!: Store
	protected override async init() {
		this.store = await this.state.open(createStore().setValues({ title: 'initial' }))
	}
}

@Plugin()
class SchemaState extends BasePlugin {
	readonly state = this.ctx.tinybase
	store!: Store
	protected override async init() {
		this.store = await this.state.open(
			createStore()
				.setValuesSchema({ title: { type: 'string' } })
				.setValue('title', 'initial'),
		)
	}
}

const directories: string[] = []
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture(plugin: PluginConstructor = SharedState) {
	const prefix = await mkdtemp(join(tmpdir(), 'pluxel-shared-files-'))
	directories.push(prefix)
	return {
		zenfs: { mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } } },
		file: join(
			prefix,
			'services/tinybase/nodes',
			`${pluginNodePhysicalKey(plugin.nodeAddress())}.json`,
		),
	}
}

it('reloads a shared file into the same native Store and Queries without writing it back', async () => {
	const { zenfs, file } = await fixture()
	await using writer = createCoreTestHost({ zenfs })
	const source = await writer.add(SharedState)
	await source.state.flush()
	await using reader = createCoreTestHost({ zenfs })
	const target = await reader.add(SharedState)
	const store = target.store
	const queries = createQueries(store).setQueryDefinition('items', 'items', ({ select }) =>
		select('name'),
	)
	try {
		source.store.setRow('items', 'first', { name: 'shared' })
		await source.state.flush()
		const saved = await stat(file)
		await expect.poll(() => queries.getResultCell('items', 'first', 'name')).toBe('shared')
		expect(target.store).toBe(store)
		await target.state.flush()
		const afterLoad = await stat(file)
		expect(afterLoad.ino).toBe(saved.ino)
		// A second writer can save sequentially; this deliberately makes no concurrent-write guarantee.
		target.store.setValue('title', 'from second host')
		await target.state.flush()
		await expect.poll(() => source.store.getValue('title')).toBe('from second host')
	} finally {
		queries.destroy()
	}
})

it('validates an external snapshot against the live native schema before notifying listeners', async () => {
	const { zenfs, file } = await fixture(SchemaState)
	await using host = createCoreTestHost({ zenfs })
	const owner = await host.add(SchemaState)
	await owner.state.flush()
	const runtime = requireTinyBaseHost(getCoreTestHostContext(host))
	const changes: unknown[] = []
	const listener = owner.store.addValueListener('title', () =>
		changes.push(owner.store.getValue('title')),
	)
	try {
		const snapshot = JSON.parse(await readFile(file, 'utf8'))
		snapshot.content[1].title = 42
		await writeFile(file, JSON.stringify(snapshot))
		await expect
			.poll(() => runtime.status().some((status) => status.error !== undefined))
			.toBe(true)
		expect(owner.store.getValue('title')).toBe('initial')
		expect(changes).toEqual([])
		snapshot.content[1].title = 'valid'
		await writeFile(file, JSON.stringify(snapshot))
		await expect.poll(() => changes).toEqual(['valid'])
		await rm(file)
		await expect.poll(() => owner.store.hasValue('title')).toBe(false)
		await owner.state.flush()
		await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
	} finally {
		owner.store.delListener(listener)
	}
})

it('clears a transient read error when the same file becomes readable again', async () => {
	const { zenfs } = await fixture()
	await using host = createCoreTestHost({ zenfs })
	const owner = await host.add(SharedState)
	await owner.state.flush()
	const ctx = getCoreTestHostContext(host)
	const runtime = requireTinyBaseHost(ctx)
	const fs = await requireFs(ctx).directory('services/tinybase/nodes')
	const read = vi.spyOn(fs, 'readFile').mockRejectedValueOnce(new Error('temporarily unavailable'))
	try {
		await expect
			.poll(() => runtime.status().some((status) => status.error !== undefined))
			.toBe(true)
		await expect
			.poll(() => runtime.status().every((status) => status.error === undefined))
			.toBe(true)
		expect(owner.store.getValue('title')).toBe('initial')
	} finally {
		read.mockRestore()
	}
})

it('keeps saving local changes after an observer throws during external loading', async () => {
	const { zenfs, file } = await fixture()
	await using host = createCoreTestHost({ zenfs })
	const owner = await host.add(SharedState)
	await owner.state.flush()
	const runtime = requireTinyBaseHost(getCoreTestHostContext(host))
	const listener = owner.store.addValueListener('title', () => {
		throw new Error('consumer failed')
	})
	const snapshot = JSON.parse(await readFile(file, 'utf8'))
	snapshot.content[1].title = 'external'
	try {
		await writeFile(file, JSON.stringify(snapshot))
		await expect
			.poll(() => runtime.status().some((status) => status.error !== undefined))
			.toBe(true)
		expect(owner.store.getValue('title')).toBe('external')
	} finally {
		owner.store.delListener(listener)
	}
	owner.store.setValue('title', 'initial')
	await owner.state.flush()
	const saved = JSON.parse(await readFile(file, 'utf8'))
	expect(saved.content[1].title).toBe('initial')
})

it('observes native writes from another process and reports malformed updates without replacing them', async () => {
	const { zenfs, file } = await fixture()
	await using host = createCoreTestHost({ zenfs })
	const owner = await host.add(SharedState)
	await owner.state.flush()
	await promisify(execFile)(process.execPath, [
		'--input-type=module',
		'-e',
		`
import {readFile,writeFile} from 'node:fs/promises';
const path = process.argv[1];
const snapshot = JSON.parse(await readFile(path, 'utf8'));
snapshot.content[1].title = 'external process';
await writeFile(path, JSON.stringify(snapshot));
`,
		file,
	])
	await expect.poll(() => owner.store.getValue('title')).toBe('external process')
	const good = await readFile(file, 'utf8')
	await writeFile(file, 'invalid external content')
	const runtime = requireTinyBaseHost(getCoreTestHostContext(host))
	await expect.poll(() => runtime.status().some((state) => state.error !== undefined)).toBe(true)
	expect(owner.store.getValue('title')).toBe('external process')
	expect(await readFile(file, 'utf8')).toBe('invalid external content')
	const repaired = JSON.parse(good)
	repaired.content[1].title = 'repaired'
	await writeFile(file, JSON.stringify(repaired))
	await expect.poll(() => owner.store.getValue('title')).toBe('repaired')
	expect(runtime.status().every((state) => state.error === undefined)).toBe(true)
	await owner.state.flush()
	expect(await readFile(file, 'utf8')).toBe(JSON.stringify(repaired))
})
