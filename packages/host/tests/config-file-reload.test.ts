import * as nativeFs from 'node:fs'
import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BasePlugin, Plugin } from '@pluxel/core'
import { Passthrough } from '@pluxel/core/fs'
import { SuperJSON } from 'superjson'
import { expect, it } from 'vitest'
import * as v from 'valibot'
import { createHost } from '../src/index'

const applied: string[] = []

@Plugin()
class FileConfigured extends BasePlugin {
	readonly config = this.configs.use(v.object({ value: v.optional(v.string(), 'default') }))

	init() {
		this.configs.onUpdate(this.config, ({ desired }) => {
			applied.push(desired.value)
		})
	}
}

it('reloads shared config files into running Hosts without rewriting external content', async () => {
	const prefix = await mkdtemp(join(tmpdir(), 'pluxel-config-reload-'))
	const owner = FileConfigured.nodeAddress()
	const options = {
		plugins: [FileConfigured],
		runtime: {
			zenfs: { mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } } },
			state: { mode: 'memory' as const },
			configRecords: { records: [{ owner, config: { value: 'base' } }] },
		},
	}
	const first = await createHost(options)
	let second: Awaited<ReturnType<typeof createHost>> | undefined
	try {
		second = await createHost(options)
		await first.startNode(owner)
		await second.startNode(owner)
		applied.length = 0
		await expect(first.config.patch(owner, { value: 'first' })).resolves.toMatchObject({
			ok: true,
			application: 'applied',
		})
		await expect
			.poll(() => second!.config.get(owner), { timeout: 3000 })
			.toMatchObject({
				ok: true,
				application: 'applied',
				config: { value: 'first' },
			})
		expect(applied).toEqual(['first', 'first'])
		await second.config.patch(owner, { value: 'second' })
		await expect
			.poll(() => first.config.get(owner), { timeout: 3000 })
			.toMatchObject({ config: { value: 'second' } })

		const file = join(prefix, 'services/host/config/config.json')
		const replace = async (value: unknown) => {
			const text = SuperJSON.stringify({
				version: 4,
				plugins: [{ owner, config: { value } }],
			})
			await writeFile(`${file}.external`, text)
			await rename(`${file}.external`, file)
			return text
		}
		const text = await replace('editor')
		await expect
			.poll(() => first.config.get(owner), { timeout: 3000 })
			.toMatchObject({
				application: 'applied',
				config: { value: 'editor' },
			})
		await expect
			.poll(() => second!.config.get(owner), { timeout: 3000 })
			.toMatchObject({ config: { value: 'editor' } })
		const before = await stat(file)
		await new Promise((resolve) => setTimeout(resolve, 650))
		expect(await readFile(file, 'utf8')).toBe(text)
		const after = await stat(file)
		expect(after.mtimeMs).toBe(before.mtimeMs)
		expect(applied.filter((value) => value === 'editor')).toHaveLength(2)

		// A rejected external config stays on disk for repair and is never applied.
		const invalid = await replace(123)
		await new Promise((resolve) => setTimeout(resolve, 650))
		await expect(first.config.get(owner)).resolves.toMatchObject({ config: { value: 'editor' } })
		await expect(second.config.get(owner)).resolves.toMatchObject({ config: { value: 'editor' } })
		expect(await readFile(file, 'utf8')).toBe(invalid)
		await replace('repaired')
		await expect
			.poll(() => first.config.get(owner), { timeout: 3000 })
			.toMatchObject({ config: { value: 'repaired' } })
		await expect
			.poll(() => second!.config.get(owner), { timeout: 3000 })
			.toMatchObject({ config: { value: 'repaired' } })

		// Removing the saved document reveals schema defaults without restoring declaration records.
		await rm(file)
		await expect
			.poll(() => first.config.get(owner), { timeout: 3000 })
			.toMatchObject({ config: { value: 'default' } })
		await expect
			.poll(() => second!.config.get(owner), { timeout: 3000 })
			.toMatchObject({ config: { value: 'default' } })
		await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
	} finally {
		await Promise.all([first.close(), second?.close()])
		await rm(prefix, { recursive: true, force: true })
	}
})

it('applies shared file updates in a Host with a readonly filesystem and config policy', async () => {
	const prefix = await mkdtemp(join(tmpdir(), 'pluxel-config-readonly-'))
	const owner = FileConfigured.nodeAddress()
	const storage = { mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } } }
	const writer = await createHost({
		plugins: [FileConfigured],
		runtime: { zenfs: storage, state: { mode: 'memory' } },
	})
	let reader: Awaited<ReturnType<typeof createHost>> | undefined
	try {
		reader = await createHost({
			plugins: [FileConfigured],
			runtime: {
				zenfs: { ...storage, readOnly: true },
				state: { mode: 'memory' },
				configRecords: { mode: 'readonly' },
			},
		})
		await reader.startNode(owner)
		await writer.config.patch(owner, { value: 'shared' })
		await expect
			.poll(() => reader!.config.get(owner), { timeout: 3000 })
			.toMatchObject({
				ok: true,
				readonly: true,
				application: 'applied',
				config: { value: 'shared' },
			})
		await expect(reader.config.patch(owner, { value: 'forbidden' })).resolves.toMatchObject({
			ok: false,
			code: 'mutation_rejected',
		})
	} finally {
		await Promise.all([writer.close(), reader?.close()])
		await rm(prefix, { recursive: true, force: true })
	}
})
