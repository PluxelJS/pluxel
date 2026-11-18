import { BasePlugin, Plugin, parsePluginNodeAddress } from '@pluxel/core'
import { createTestHost } from '@pluxel/test'
import { envBinding, defineHostApplication, resolveHostApplication } from '@pluxel/host'
import { createResolvedHost } from '@pluxel/host/internal'
import { elysia } from '@pluxel/services/elysia'
import { commands } from '@pluxel/services/commands'
import { nodeModules } from '@pluxel/services/node'
import { workers } from '@pluxel/services/workers'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const s3Mock = vi.hoisted(() => {
	const clients: Array<Record<string, any>> = []
	const configs: Array<Record<string, any>> = []
	return { clients, configs }
})

vi.mock('s3mini', () => ({
	S3mini: class {
		getObject = vi.fn()
		putObject = vi.fn()

		constructor(config: Record<string, unknown>) {
			s3Mock.configs.push(config)
			s3Mock.clients.push(this)
		}
	},
}))

import { S3, S3NotRunningError, S3VaultSchema, S3Plugin } from '../src/index.ts'
import { DocumentsPlugin } from './fixtures/result-consumer.ts'

@Plugin()
class S3Consumer extends BasePlugin {
	constructor(readonly s3: S3) {
		super()
	}
}

@Plugin()
class S3ConsumerA extends BasePlugin {
	constructor(readonly s3: S3) {
		super()
	}
}

@Plugin()
class S3ConsumerB extends BasePlugin {
	constructor(readonly s3: S3) {
		super()
	}
}

beforeEach(() => {
	s3Mock.clients.length = 0
	s3Mock.configs.length = 0
	vi.unstubAllGlobals()
})

describe('S3Plugin remote backend', () => {
	it('demonstrates object absence as a Result without swallowing IO or permission failures', async () => {
		await using host = await createTestHost()
		await host.start(S3Plugin.nodeAddress(), { initialConfig: remoteConfig({ type: 'anonymous' }) })
		const documents = await host.start(DocumentsPlugin.nodeAddress())
		const client = s3Mock.clients.at(-1)!
		client.getObject.mockResolvedValueOnce('').mockResolvedValueOnce(null)
		const empty = await documents.read('empty')
		expect(empty.unwrap()).toBe('')
		const missing = await documents.read('missing')
		expect(missing.isErr()).toBe(true)
		if (missing.isOk()) throw new Error('Expected a missing document')
		expect(missing.error).toMatchObject({ _tag: 'DocumentNotFound', id: 'missing' })
		const denied = new Error('AccessDenied')
		client.getObject.mockRejectedValueOnce(denied)
		await expect(documents.read('private')).rejects.toBe(denied)
		await host.stop(S3Plugin.nodeAddress())
		await expect(documents.read('stopped')).rejects.toThrow(Error)
	})

	it('exposes a real anonymous s3mini client from the same configurable provider', async () => {
		await withRemoteS3(async (s3, client, config) => {
			expect(s3.bucket().client).toBe(client)
			expect(config).toMatchObject({
				accessKeyId: '',
				secretAccessKey: '',
				endpoint: 'https://bucket.s3.example.com',
				region: 'auto',
				requestSizeInBytes: 4 * 1024 * 1024,
				requestAbortTimeout: 30_000,
				minPartSize: 8 * 1024 * 1024,
			})
			client.putObject.mockResolvedValue(new Response(null, { status: 200 }))
			await s3.bucket().client.putObject('native/key', 'body')
			expect(client.putObject).toHaveBeenCalledWith('native/key', 'body')
		})
	})

	it('starts an environment-only deployment without encrypted storage and fails closed for missing input', async () => {
		const application = defineHostApplication(() => ({
			plugins: [
				{
					plugin: S3Plugin,
					autoStart: true,
					config: remoteConfig({ type: 'vault', key: 'primary' }),
					envBindings: [
						envBinding({
							vault: {
								schema: S3VaultSchema,
								mapping: {
									primary: { accessKeyId: 'S3_ACCESS_KEY', secretAccessKey: 'S3_SECRET_KEY' },
								},
							},
						}),
					],
				},
			],
			coreConfig: { vault: { backend: 'bindings' } },
		}))
		const startup = {
			root: process.cwd(),
			mode: 'test' as const,
			env: { S3_ACCESS_KEY: 'env-access', S3_SECRET_KEY: 'env-secret' },
			bindings: {},
		}
		const resolved = await resolveHostApplication(application, startup)
		const host = await createResolvedHost(resolved)
		try {
			await host.start()
			const status = await host.status()
			expect(status.summary.running).toBe(1)
			expect(s3Mock.configs.at(-1)).toMatchObject({
				accessKeyId: 'env-access',
				secretAccessKey: 'env-secret',
			})
		} finally {
			await host.close()
		}
		await expect(
			resolveHostApplication(application, {
				...startup,
				env: { S3_ACCESS_KEY: 'env-access' },
			}),
		).rejects.toThrow('S3_SECRET_KEY')
	})

	it('resolves access keys from a configured Vault reference without another plugin', async () => {
		{
			await using host = await createTestHost({
				services: [elysia(), commands(), nodeModules(), workers()],
			})

			await host.start(S3Plugin.nodeAddress(), {
				initialConfig: remoteConfig({ type: 'anonymous' }),
			})
			await host
				.require(S3Plugin.nodeAddress())
				.ctx.vault.kv({ namespace: 'shared-secrets' })
				.set('assets.s3', {
					accessKeyId: 'access-id',
					secretAccessKey: 'secret-value',
				})

			await host.stop(S3Plugin.nodeAddress())
			await host.config.patch(S3Plugin.nodeAddress(), {
				set: remoteConfig({
					type: 'vault',
					key: 'assets.s3',
					namespace: 'shared-secrets',
				}),
			})
			await host.start(S3Plugin.nodeAddress())
			await host.start(S3Consumer.nodeAddress())
			expect(s3Mock.configs.at(-1)).toMatchObject({
				accessKeyId: 'access-id',
				secretAccessKey: 'secret-value',
			})
			const consumer = host.require(S3Consumer.nodeAddress())
			const handle = consumer.s3.bucket()
			const previous = handle.client
			const kv = host.require(S3Plugin.nodeAddress()).ctx.vault.kv({ namespace: 'shared-secrets' })
			await kv.set('assets.s3', { accessKeyId: 'rotated-id', secretAccessKey: 'rotated-secret' })
			await vi.waitFor(() => expect(handle.client).not.toBe(previous))
			expect(s3Mock.configs.at(-1)).toMatchObject({
				accessKeyId: 'rotated-id',
				secretAccessKey: 'rotated-secret',
			})
			await kv.delete('assets.s3')
			await vi.waitFor(() => expect(() => handle.client).toThrow('missing'))
		}
	})

	it('provides O(1) named bucket selection and owner-bound handles', async () => {
		{
			await using host = await createTestHost({
				services: [elysia(), commands(), nodeModules(), workers()],
			})

			await host.start(S3Plugin.nodeAddress(), {
				initialConfig: {
					buckets: [
						remoteBucket('east', { type: 'anonymous' }, 'https://east-bucket.s3.example.com'),
						remoteBucket('west', { type: 'anonymous' }, 'https://west-bucket.s3.example.com'),
					],
				},
			})
			await host.start([S3ConsumerA.nodeAddress(), S3ConsumerB.nodeAddress()])
			const eastCapability = host.require(S3ConsumerA.nodeAddress()).s3.bucket('east')
			const westCapability = host.require(S3ConsumerB.nodeAddress()).s3.bucket('west')
			const eastClient = eastCapability.client
			const westClient = westCapability.client
			expect(eastClient).not.toBe(westClient)
			expect(host.require(S3ConsumerA.nodeAddress()).s3.bucket('east')).toBe(eastCapability)
			expect(host.require(S3ConsumerA.nodeAddress()).s3.bucketIds()).toEqual(['east', 'west'])
			expect(() => host.require(S3ConsumerA.nodeAddress()).s3.bucket('missing')).toThrowError(
				expect.objectContaining({ code: 'S3_BUCKET_NOT_FOUND' }),
			)
			expect(s3Mock.configs.map((config) => config.endpoint).sort()).toEqual([
				'https://east-bucket.s3.example.com',
				'https://west-bucket.s3.example.com',
			])
			await host.stop(S3ConsumerA.nodeAddress())
			expect(() => eastCapability.client).toThrow('Plugin owner stopped')
			expect(westCapability.client).toBe(westClient)
		}
	})

	it('fails lifecycle when a configured Vault reference is missing', async () => {
		{
			await using host = await createTestHost({
				services: [elysia(), commands(), nodeModules(), workers()],
			})

			const failure = await host.commitExpectFail((change) => {
				change.catalog.add([S3Plugin, S3Consumer])
				change.config.seed(
					S3Plugin.nodeAddress(),
					remoteConfig({ type: 'vault', key: 'missing.s3' }),
				)
				change.start(S3Plugin.nodeAddress())
				change.start(S3Consumer.nodeAddress())
			})
			expect(host.isRunning(S3Plugin.nodeAddress())).toBe(false)
			expect(failure.lifecycleReport.issues).toContainEqual(
				expect.objectContaining({
					plugin: parsePluginNodeAddress(S3Plugin.nodeAddress()),
					kind: 'start-failed',
				}),
			)
		}
	})

	it('aborts s3mini fetches and revokes the capability when the provider stops', async () => {
		const fetchMock = vi.fn(
			(_input: unknown, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), {
						once: true,
					})
				}),
		)
		vi.stubGlobal('fetch', fetchMock)

		{
			await using host = await createTestHost({
				services: [elysia(), commands(), nodeModules(), workers()],
			})

			await host.start(S3Plugin.nodeAddress(), {
				initialConfig: remoteConfig({ type: 'anonymous' }),
			})
			await host.start(S3Consumer.nodeAddress())
			const capability = host.require(S3Consumer.nodeAddress()).s3
			const client = s3Mock.clients.at(-1)!
			const config = s3Mock.configs.at(-1)!
			client.getObject.mockImplementation(() => config.fetch('https://bucket/key', {}))
			const bucket = capability.bucket()
			const pending = bucket.client.getObject('key')
			await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())

			await host.stop(S3Plugin.nodeAddress())
			await expect(pending).rejects.toBeInstanceOf(S3NotRunningError)
			expect(() => bucket.client).toThrow('Plugin owner stopped')
		}
	})
})

type RemoteCredentials = { type: 'anonymous' } | { type: 'vault'; key: string; namespace?: string }

function remoteConfig(credentials: RemoteCredentials) {
	return {
		buckets: [remoteBucket('default', credentials, 'https://bucket.s3.example.com')],
	}
}

function remoteBucket(id: string, credentials: RemoteCredentials, endpoint: string) {
	return {
		id,
		backend: {
			type: 'remote' as const,
			endpoint,
			region: 'auto',
			credentials,
			requestSizeInBytes: 4 * 1024 * 1024,
			requestAbortTimeout: 30_000,
			minPartSize: 8 * 1024 * 1024,
		},
	}
}

async function withRemoteS3(
	run: (s3: S3, client: Record<string, any>, config: Record<string, any>) => void | Promise<void>,
): Promise<void> {
	{
		await using host = await createTestHost({
			services: [elysia(), commands(), nodeModules(), workers()],
		})

		await host.start(S3Plugin.nodeAddress(), {
			initialConfig: remoteConfig({ type: 'anonymous' }),
		})
		await host.start(S3Consumer.nodeAddress())
		await run(
			host.require(S3Consumer.nodeAddress()).s3,
			s3Mock.clients.at(-1)!,
			s3Mock.configs.at(-1)!,
		)
	}
}
