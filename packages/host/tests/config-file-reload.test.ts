import { BasePlugin, Plugin } from '@pluxel/core'
import { Passthrough } from '@pluxel/core/fs'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { SuperJSON } from 'superjson'
import { expect, it, onTestFinished, vi } from 'vitest'
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
	await using fixture = await createDiskFixture({})
	const owner = FileConfigured.nodeAddress()
	const options = {
		plugins: [{ plugin: FileConfigured, config: { value: 'base' } }],
		config: { mode: 'saved-first' },
		policy: { document: false },
		coreConfig: {
			zenfs: { mounts: { '/': { backend: Passthrough, fs: fixture.fs, prefix: fixture.path } } },
		},
	} as const
	await using first = await createHost(options)
	await using second = await createHost(options)
	await Promise.all([first.startNode(owner), second.startNode(owner)])
	applied.length = 0
	await expect(first.config.patch(owner, { set: { value: 'first' } })).resolves.toMatchObject({
		ok: true,
		application: 'applied',
	})
	await expect
		.poll(() => second.config.get(owner), { timeout: 3000 })
		.toMatchObject({ ok: true, application: 'applied', config: { value: 'first' } })
	expect(applied).toEqual(['first', 'first'])
	await second.config.patch(owner, { set: { value: 'second' } })
	await expect
		.poll(() => first.config.get(owner), { timeout: 3000 })
		.toMatchObject({ config: { value: 'second' } })

	const file = fixture.getPath('services/host/config/config.json')
	const replace = async (value: unknown) => {
		const text = SuperJSON.stringify({ version: 4, plugins: [{ owner, config: { value } }] })
		await fixture.fsp.writeFile(`${file}.external`, text)
		await fixture.fsp.rename(`${file}.external`, file)
		return text
	}
	const expectApplied = (value: string) => {
		const entry = { ok: true, application: 'applied', config: { value } }
		return expect
			.poll(() => Promise.all([first.config.get(owner), second.config.get(owner)]), {
				timeout: 3000,
			})
			.toMatchObject([entry, entry])
	}
	const text = await replace('editor')
	const before = await fixture.fsp.stat(file)
	await expectApplied('editor')
	expect(await fixture.fsp.readFile(file, 'utf8')).toBe(text)
	const after = await fixture.fsp.stat(file)
	expect(after.mtimeMs).toBe(before.mtimeMs)
	expect(applied.filter((value) => value === 'editor')).toHaveLength(2)

	const errors = [vi.spyOn(first.ctx.logger, 'error'), vi.spyOn(second.ctx.logger, 'error')]
	onTestFinished(() => {
		for (const error of errors) error.mockRestore()
	})
	const changesBeforeRejection = [...applied]
	const invalid = await replace(123)
	for (const error of errors) {
		await expect
			.poll(() => error.mock.calls, { timeout: 3000 })
			.toContainEqual([
				'ConfigService external reload failed',
				{
					error: expect.objectContaining({
						message: expect.stringContaining('Plugin config schema'),
					}),
				},
			])
	}
	await expectApplied('editor')
	expect(applied).toEqual(changesBeforeRejection)
	expect(await fixture.fsp.readFile(file, 'utf8')).toBe(invalid)
	await replace('repaired')
	await expectApplied('repaired')

	await fixture.fsp.rm(file)
	await expectApplied('base')
	await expect(fixture.fsp.stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('applies shared file updates in a Host with a readonly filesystem and config policy', async () => {
	await using fixture = await createDiskFixture({})
	const owner = FileConfigured.nodeAddress()
	const storage = {
		mounts: { '/': { backend: Passthrough, fs: fixture.fs, prefix: fixture.path } },
	}
	const options = { plugins: [{ plugin: FileConfigured }], policy: { document: false } } as const
	await using writer = await createHost({ ...options, coreConfig: { zenfs: storage } })
	await using reader = await createHost({
		...options,
		coreConfig: { zenfs: { ...storage, readOnly: true } },
		config: { document: { readOnly: true } },
	})
	await reader.startNode(owner)
	await writer.config.patch(owner, { set: { value: 'shared' } })
	await expect
		.poll(() => reader.config.get(owner), { timeout: 3000 })
		.toMatchObject({
			ok: true,
			readonly: true,
			application: 'applied',
			config: { value: 'shared' },
		})
	await expect(reader.config.patch(owner, { set: { value: 'forbidden' } })).resolves.toMatchObject({
		ok: false,
		code: 'mutation_rejected',
	})
})
