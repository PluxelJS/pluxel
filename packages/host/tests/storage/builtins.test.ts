import * as nativeFs from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BasePlugin, Plugin, parsePluginNodeAddress, type HostDocumentStorage } from '@pluxel/core'
import { Passthrough } from '@pluxel/core/fs'
import { requireFs, requireHostDocuments, requireTinyBaseHost } from '@pluxel/core/internal'
import { SuperJSON } from 'superjson'
import { afterEach, describe, expect, it } from 'vitest'
import * as v from 'valibot'
import { createHost, requireHostStateStore } from '../../src/host'

@Plugin()
class Configured extends BasePlugin {
	readonly config = this.configs.use(v.object({ value: v.optional(v.string(), 'startup') }))
}

const directories: string[] = []

async function temporaryDirectory(): Promise<string> {
	const prefix = await mkdtemp(join(tmpdir(), 'pluxel-builtin-storage-'))
	directories.push(prefix)
	return prefix
}

async function savedDocuments(prefix: string): Promise<readonly (readonly [string, string])[]> {
	return Promise.all(
		['config/config.json', 'state/state.json'].map(
			async (name) => [name, await readFile(join(prefix, 'services/host', name), 'utf8')] as const,
		),
	)
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('Host built-in storage without Services', () => {
	it('creates built-in documents on explicit writes and reopens them read-only without rewriting them', async () => {
		const prefix = await temporaryDirectory()
		const owner = Configured.nodeAddress()
		const storage = {
			mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
			durableMounts: ['/'],
		}
		{
			await using seed = await createHost({
				plugins: [{ plugin: Configured }],
				coreConfig: { zenfs: storage },
			})
			expect(await requireHostDocuments(seed.ctx, 'config').getText('config.json')).toBeUndefined()
			expect(await requireHostDocuments(seed.ctx, 'state').getText('state.json')).toBeUndefined()
			await expect(
				seed.config.patch(owner, { set: { value: 'persisted' } }),
			).resolves.toMatchObject({
				ok: true,
				persistence: { status: 'confirmed', retention: 'declared-durable' },
			})
			await expect(
				seed.policy.patch({ startConcurrency: 2, autoStart: [{ node: owner, autoStart: true }] }),
			).resolves.toMatchObject({
				ok: true,
				persistence: { status: 'confirmed', retention: 'declared-durable' },
			})
		}
		const confirmed = await savedDocuments(prefix)
		{
			await using reopened = await createHost({
				plugins: [{ plugin: Configured, config: { value: 'replacement seed' } }],
				config: { mode: 'saved-first', document: { readOnly: true } },
				policy: { document: { readOnly: true }, modes: { autoStart: 'saved-first' } },
				coreConfig: { zenfs: { ...storage, readOnly: true } },
			})
			await expect(reopened.config.get(owner)).resolves.toMatchObject({
				ok: true,
				readonly: true,
				config: { value: 'persisted' },
			})
			await expect(reopened.policy.get()).resolves.toMatchObject({
				ok: true,
				appliedExecution: { startConcurrency: 2 },
				effective: { autoStart: [parsePluginNodeAddress(owner)] },
			})
			await expect(
				reopened.config.patch(owner, { set: { value: 'rejected' } }),
			).resolves.toMatchObject({
				ok: false,
				code: 'mutation_rejected',
			})
			await expect(reopened.setAutoStart(owner, false)).rejects.toMatchObject({
				code: 'mutation_rejected',
			})
			expect(requireHostStateStore(reopened.ctx).snapshot().autoStart).toEqual([
				parsePluginNodeAddress(owner),
			])
		}
		expect(await savedDocuments(prefix)).toEqual(confirmed)
	})

	it('keeps readonly startup seeds without creating missing built-in documents', async () => {
		const prefix = await temporaryDirectory()
		const owner = Configured.nodeAddress()
		const host = await createHost({
			plugins: [
				{
					plugin: Configured,
					autoStart: true,
					config: { value: 'readonly seed' },
				},
			],
			config: {
				document: { readOnly: true },
			},
			policy: {
				document: { readOnly: true },
			},
			coreConfig: {
				zenfs: {
					mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
					readOnly: true,
					durableMounts: ['/'],
				},
			},
		})
		try {
			await expect(host.config.get(owner)).resolves.toMatchObject({
				ok: true,
				readonly: true,
				config: { value: 'readonly seed' },
			})
			expect(requireHostStateStore(host.ctx).snapshot().autoStart).toEqual([
				parsePluginNodeAddress(owner),
			])
			expect(await requireHostDocuments(host.ctx, 'config').getText('config.json')).toBeUndefined()
			expect(await requireHostDocuments(host.ctx, 'state').getText('state.json')).toBeUndefined()
		} finally {
			await host.close()
		}
		expect(await readdir(prefix)).toEqual([])
	})

	it('keeps explicitly selected memory domains out of the configured durable filesystem', async () => {
		const prefix = await temporaryDirectory()
		const owner = Configured.nodeAddress()
		const host = await createHost({
			plugins: [
				{
					plugin: Configured,
				},
			],
			coreConfig: {
				zenfs: {
					mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
					durableMounts: ['/'],
				},
			},
			policy: {
				document: false,
			},
			config: {
				document: false,
			},
		})
		try {
			await expect(
				host.config.patch(owner, { set: { value: 'temporary' } }),
			).resolves.toMatchObject({
				ok: true,
				persistence: { status: 'confirmed' },
			})
			await host.setAutoStart(owner, true)
			expect(requireTinyBaseHost(host.ctx).status()).toEqual([])
		} finally {
			await host.close()
		}
		expect(await readdir(prefix)).toEqual([])
	})

	it('resolves document factories before IO and prepares the shared filesystem once', async () => {
		const prefix = join(await temporaryDirectory(), 'data')
		await mkdir(prefix, { recursive: true })
		const calls: string[] = []
		const backend = {
			...Passthrough,
			create(options: Parameters<typeof Passthrough.create>[0]) {
				calls.push('open')
				return Passthrough.create(options)
			},
		}
		const host = await createHost({
			plugins: [],
			coreConfig: {
				zenfs: { mounts: { '/': { backend, fs: nativeFs, prefix } }, durableMounts: ['/'] },
			},
			policy: {
				document: {
					storage(root) {
						calls.push('state factory')
						return requireHostDocuments(root, 'state')
					},
				},
			},
			config: {
				document: {
					storage(root) {
						calls.push('config factory')
						return requireHostDocuments(root, 'config')
					},
				},
			},
		})
		try {
			expect(calls.slice(0, 3)).toEqual(['config factory', 'state factory', 'open'])
			expect(calls.filter((call) => call === 'open')).toHaveLength(1)
			await Promise.all([requireFs(host.ctx).ready(), requireFs(host.ctx).ready()])
			expect(calls.filter((call) => call === 'open')).toHaveLength(1)
		} finally {
			await host.close()
		}
	})

	it('shares a failed preparation, never retries it, and closes the failed Host root', async () => {
		const prefix = await temporaryDirectory()
		const failure = Object.assign(new Error('native backend unavailable'), { code: 'EACCES' })
		let attempts = 0
		let filesystem!: ReturnType<typeof requireFs>
		const backend = {
			...Passthrough,
			create() {
				attempts++
				throw failure
			},
		}
		await expect(
			createHost({
				plugins: [],
				coreConfig: {
					zenfs: { mounts: { '/': { backend, fs: nativeFs, prefix } }, durableMounts: ['/'] },
				},
				policy: {
					document: { storage: (root) => requireHostDocuments(root, 'state') },
				},
				config: {
					document: {
						storage(root) {
							filesystem = requireFs(root)
							return requireHostDocuments(root, 'config')
						},
					},
				},
			}),
		).rejects.toBe(failure)
		await expect(filesystem.ready()).rejects.toMatchObject({ code: 'EBADF' })
		expect(attempts).toBe(1)
	})

	it('closes built-in documents after corrupt config rejects startup and preserves their bytes', async () => {
		const prefix = await temporaryDirectory()
		const coreConfig = {
			zenfs: {
				mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
				durableMounts: ['/'],
			},
		}
		const original = '{broken'
		const seed = await createHost({ coreConfig })
		try {
			await requireHostDocuments(seed.ctx, 'config').put('config.json', original)
			await requireHostDocuments(seed.ctx, 'state').put(
				'state.json',
				SuperJSON.stringify({ version: 8 }),
			)
		} finally {
			await seed.close()
		}
		const before = await savedDocuments(prefix)
		let filesystem!: ReturnType<typeof requireFs>
		let documents!: HostDocumentStorage
		await expect(
			createHost({
				coreConfig,
				config: {
					document: {
						storage(root) {
							filesystem = requireFs(root)
							documents = requireHostDocuments(root, 'config')
							return documents
						},
					},
				},
			}),
		).rejects.toMatchObject({
			message: expect.stringContaining('[ConfigService] Cannot load config.json:'),
			cause: expect.any(SyntaxError),
		})
		await expect(filesystem.ready()).rejects.toMatchObject({ code: 'EBADF' })
		expect(() => documents.getText('config.json')).toThrow(
			expect.objectContaining({ code: 'EBADF' }),
		)
		expect(await savedDocuments(prefix)).toEqual(before)
	})
})
