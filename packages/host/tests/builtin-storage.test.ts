import * as nativeFs from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BasePlugin, Plugin, pluginNodeAddressOf, type HostDocumentStorage } from '@pluxel/core'
import { Passthrough } from '@pluxel/core/fs'
import { requireFs, requireTinyBaseHost } from '@pluxel/core/internal'
import { SuperJSON } from 'superjson'
import { afterEach, describe, expect, it } from 'vitest'
import * as v from 'valibot'
import { createHost, requireHostStateStore } from '../src/host'

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
	const path = join(prefix, 'services/tinybase/host')
	const names = await readdir(path)
	names.sort()
	return Promise.all(
		names.map(async (name) => [name, await readFile(join(path, name), 'utf8')] as const),
	)
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('Host built-in storage without Services', () => {
	it('reopens default documents with only readonly modes on a readonly filesystem and rejects management writes', async () => {
		const prefix = await temporaryDirectory()
		const owner = pluginNodeAddressOf(Configured)
		const storage = {
			mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
			durableMounts: ['/'],
		}
		const seed = await createHost({
			plugins: [Configured],
			config: { storage },
			configRecords: { mode: 'writable' },
			state: { mode: 'writable' },
		})
		try {
			await expect(seed.config.patch(owner, { value: 'persisted' })).resolves.toMatchObject({
				ok: true,
				saved: true,
			})
			await seed.setAutoStart(owner, true)
		} finally {
			await seed.close()
		}
		const confirmed = await savedDocuments(prefix)
		const reopened = await createHost({
			plugins: [Configured],
			config: { storage: { ...storage, readOnly: true } },
			configRecords: {
				mode: 'readonly',
				initial: [{ owner, config: { value: 'replacement seed' } }],
			},
			state: { mode: 'readonly', initial: { autoStart: [] } },
		})
		try {
			await expect(reopened.config.get(owner)).resolves.toMatchObject({
				ok: true,
				readonly: true,
				config: { value: 'persisted' },
			})
			expect(requireHostStateStore(reopened.ctx).snapshot().autoStart).toEqual([owner])
			await expect(reopened.config.patch(owner, { value: 'rejected' })).resolves.toMatchObject({
				ok: false,
				code: 'mutation_rejected',
			})
			await expect(reopened.setAutoStart(owner, false)).rejects.toMatchObject({
				cause: expect.objectContaining({ message: expect.stringContaining('readonly mode') }),
			})
			expect(requireHostStateStore(reopened.ctx).snapshot().autoStart).toEqual([owner])
		} finally {
			await reopened.close()
		}
		expect(await savedDocuments(prefix)).toEqual(confirmed)
	})

	it('keeps readonly startup seeds without creating missing built-in documents', async () => {
		const prefix = await temporaryDirectory()
		const owner = pluginNodeAddressOf(Configured)
		const host = await createHost({
			plugins: [Configured],
			config: {
				storage: {
					mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
					readOnly: true,
					durableMounts: ['/'],
				},
			},
			configRecords: { mode: 'readonly', initial: [{ owner, config: { value: 'readonly seed' } }] },
			state: { mode: 'readonly', initial: { autoStart: [owner] } },
		})
		try {
			await expect(host.config.get(owner)).resolves.toMatchObject({
				ok: true,
				readonly: true,
				config: { value: 'readonly seed' },
			})
			expect(requireHostStateStore(host.ctx).snapshot().autoStart).toEqual([owner])
			expect(
				await requireTinyBaseHost(host.ctx).documents('config').getText('config.json'),
			).toBeUndefined()
			expect(
				await requireTinyBaseHost(host.ctx).documents('state').getText('state.json'),
			).toBeUndefined()
		} finally {
			await host.close()
		}
		expect(await readdir(prefix)).toEqual([])
	})

	it('keeps explicitly selected memory domains out of the configured durable filesystem', async () => {
		const prefix = await temporaryDirectory()
		const owner = pluginNodeAddressOf(Configured)
		const host = await createHost({
			plugins: [Configured],
			config: {
				storage: {
					mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
					durableMounts: ['/'],
				},
			},
			configRecords: { mode: 'memory' },
			state: { mode: 'memory' },
		})
		try {
			await expect(host.config.patch(owner, { value: 'temporary' })).resolves.toMatchObject({
				ok: true,
				saved: true,
			})
			await host.setAutoStart(owner, true)
			expect(requireTinyBaseHost(host.ctx).status()).toEqual([])
		} finally {
			await host.close()
		}
		expect(await readdir(prefix)).toEqual([])
	})

	it.each(['writer', 'replica'] as const)(
		'rejects synchronization on readonly default config documents for a %s',
		async (role) => {
			const prefix = await temporaryDirectory()
			const shared = {
				scope: 'readonly',
				artifact: { name: '@fixture/readonly', catalogHash: 'a'.repeat(64) },
			}
			await expect(
				createHost({
					plugins: [],
					config: {
						storage: {
							mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
							durableMounts: ['/'],
						},
					},
					configRecords: { mode: 'readonly' },
					state: { mode: 'memory' },
					configSync:
						role === 'writer'
							? { ...shared, role, identity: 'writer', replicas: [] }
							: {
									...shared,
									role,
									identity: 'replica',
									writer: 'writer',
									url: 'http://127.0.0.1:1/config',
									token: 'readonly-fixture-secret',
								},
				}),
			).rejects.toThrow('Synchronization requires writable local document storage')
			expect(await readdir(prefix)).toEqual([])
		},
	)

	it('persists default config and state through the fixed Core document namespaces', async () => {
		const prefix = await temporaryDirectory()
		const host = await createHost({
			plugins: [],
			config: {
				storage: {
					mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
					durableMounts: ['/'],
				},
			},
		})
		try {
			const documents = requireTinyBaseHost(host.ctx)
			expect(documents.status().map(({ identity }) => identity)).toEqual([
				{ kind: 'host', namespace: 'config' },
				{ kind: 'host', namespace: 'state' },
			])
			expect(
				SuperJSON.parse((await documents.documents('config').getText('config.json'))!),
			).toEqual({
				version: 3,
				plugins: [],
			})
			expect(await documents.documents('state').getText('state.json')).toBeTypeOf('string')
			expect(await savedDocuments(prefix)).toHaveLength(2)
		} finally {
			await host.close()
		}
		const confirmed = await savedDocuments(prefix)
		const reopened = await createHost({
			plugins: [],
			config: {
				storage: {
					mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
					durableMounts: ['/'],
				},
			},
		})
		try {
			expect(await savedDocuments(prefix)).toEqual(confirmed)
		} finally {
			await reopened.close()
		}
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
			config: {
				storage: { mounts: { '/': { backend, fs: nativeFs, prefix } }, durableMounts: ['/'] },
			},
			configRecords: {
				storage(root) {
					calls.push('config factory')
					return requireTinyBaseHost(root).documents('config')
				},
			},
			state: {
				storage(root) {
					calls.push('state factory')
					return requireTinyBaseHost(root).documents('state')
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
		let observed!: PromiseSettledResult<unknown>[]
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
				config: {
					storage: { mounts: { '/': { backend, fs: nativeFs, prefix } }, durableMounts: ['/'] },
				},
				configRecords: {
					storage(root) {
						filesystem = requireFs(root)
						const documents = filesystem.documents('host/config')
						return {
							...documents,
							async getText(key) {
								observed = await Promise.allSettled([
									documents.getText(key),
									filesystem.ready(),
									documents.getText(key),
								])
								throw failure
							},
						}
					},
				},
				state: { storage: (root) => requireFs(root).documents('host/state') },
			}),
		).rejects.toBe(failure)
		expect(observed).toEqual(
			Array.from({ length: 3 }, () => ({ status: 'rejected', reason: failure })),
		)
		expect(attempts).toBe(1)
		await expect(filesystem.ready()).rejects.toMatchObject({ code: 'EBADF' })
		expect(attempts).toBe(1)
	})

	it('closes built-in documents after corrupt config rejects startup and preserves their bytes', async () => {
		const prefix = await temporaryDirectory()
		const config = {
			storage: {
				mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
				durableMounts: ['/'],
			},
		}
		const original = '{broken'
		const seed = await createHost({ plugins: [], config })
		try {
			await requireTinyBaseHost(seed.ctx).documents('config').put('config.json', original)
		} finally {
			await seed.close()
		}
		const before = await savedDocuments(prefix)
		let filesystem!: ReturnType<typeof requireFs>
		let documents!: HostDocumentStorage
		await expect(
			createHost({
				plugins: [],
				config,
				configRecords: {
					storage(root) {
						filesystem = requireFs(root)
						documents = requireTinyBaseHost(root).documents('config')
						return documents
					},
				},
			}),
		).rejects.toMatchObject({
			message: expect.stringContaining('[ConfigService] Cannot load config.json:'),
			cause: expect.any(SyntaxError),
		})
		await expect(filesystem.ready()).rejects.toMatchObject({ code: 'EBADF' })
		await expect(documents.getText('config.json')).rejects.toMatchObject({ code: 'CLOSED' })
		expect(await savedDocuments(prefix)).toEqual(before)
	})
})
