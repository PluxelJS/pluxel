import type { PluginConstructor } from '@pluxel/runtime'
import { BasePlugin, Plugin, type RuntimeHost, withRuntimeHost } from '@pluxel/runtime/test'
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

import { S3, S3CredentialsError, S3NotRunningError, S3Plugin } from '../src/index.ts'

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

@Plugin()
class S3VaultSeeder extends BasePlugin {}

function addStarted(host: RuntimeHost, plugins: readonly PluginConstructor[]): void {
	host.add(plugins)
	for (const PluginClass of plugins) host.start(PluginClass)
}

beforeEach(() => {
	s3Mock.clients.length = 0
	s3Mock.configs.length = 0
	vi.unstubAllGlobals()
})

describe('S3Plugin remote backend', () => {
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

	it('resolves access keys from a configured Vault reference without another plugin', async () => {
		await withRuntimeHost(
			async (host) => {
				addStarted(host, [S3VaultSeeder])
				await host.commit()
				await host
					.require(S3VaultSeeder)
					.ctx.vault!.kv({ namespace: 'shared-secrets' })
					.set('assets.s3', {
						accessKeyId: 'access-id',
						secretAccessKey: 'secret-value',
					})

				addStarted(host, [S3Plugin, S3Consumer])
				host.cfg(S3Plugin).set({
					...remoteConfig({
						type: 'vault',
						key: 'assets.s3',
						namespace: 'shared-secrets',
					}),
				})
				await host.commit()
				expect(s3Mock.configs.at(-1)).toMatchObject({
					accessKeyId: 'access-id',
					secretAccessKey: 'secret-value',
				})
			},
			{ vault: {} },
		)
	})

	it('provides O(1) named bucket selection and owner-bound handles', async () => {
		await withRuntimeHost(async (host) => {
			addStarted(host, [S3Plugin, S3ConsumerA, S3ConsumerB])
			host.cfg(S3Plugin).set({
				buckets: [
					remoteBucket('east', { type: 'anonymous' }, 'https://east-bucket.s3.example.com'),
					remoteBucket('west', { type: 'anonymous' }, 'https://west-bucket.s3.example.com'),
				],
			})

			await host.commit()
			const eastCapability = host.require(S3ConsumerA).s3.bucket('east')
			const westCapability = host.require(S3ConsumerB).s3.bucket('west')
			const eastClient = eastCapability.client
			const westClient = westCapability.client
			expect(eastClient).not.toBe(westClient)
			expect(host.require(S3ConsumerA).s3.bucket('east')).toBe(eastCapability)
			expect(host.require(S3ConsumerA).s3.bucketIds()).toEqual(['east', 'west'])
			expect(() => host.require(S3ConsumerA).s3.bucket('missing')).toThrowError(
				expect.objectContaining({ code: 'S3_BUCKET_NOT_FOUND' }),
			)
			expect(s3Mock.configs.map((config) => config.endpoint).sort()).toEqual([
				'https://east-bucket.s3.example.com',
				'https://west-bucket.s3.example.com',
			])
			host.stop(S3ConsumerA)
			await host.commit()
			expect(() => eastCapability.client).toThrow('Plugin owner stopped')
			expect(westCapability.client).toBe(westClient)
		})
	})

	it('fails lifecycle when a configured Vault reference is missing', async () => {
		await withRuntimeHost(async (host) => {
			addStarted(host, [S3Plugin, S3Consumer])
			host.cfg(S3Plugin).set({
				...remoteConfig({ type: 'vault', key: 'missing.s3' }),
			})
			const commit = await host.commitAllowFail()
			expect(host.isRunning(S3Plugin)).toBe(false)
			expect(
				commit.lifecycleReport.issues.some(
					(issue) => issue.error?.name === S3CredentialsError.name,
				),
			).toBe(true)
		})
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

		await withRuntimeHost(async (host) => {
			addStarted(host, [S3Plugin, S3Consumer])
			host.cfg(S3Plugin).set(remoteConfig({ type: 'anonymous' }))
			await host.commit()
			const capability = host.require(S3Consumer).s3
			const client = s3Mock.clients.at(-1)!
			const config = s3Mock.configs.at(-1)!
			client.getObject.mockImplementation(() => config.fetch('https://bucket/key', {}))
			const bucket = capability.bucket()
			const pending = bucket.client.getObject('key')
			await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())

			host.stop(S3Plugin)
			await host.commit()
			await expect(pending).rejects.toBeInstanceOf(S3NotRunningError)
			expect(() => bucket.client).toThrow('Plugin owner stopped')
		})
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
	await withRuntimeHost(async (host) => {
		addStarted(host, [S3Plugin, S3Consumer])
		host.cfg(S3Plugin).set(remoteConfig({ type: 'anonymous' }))
		await host.commit()
		await run(host.require(S3Consumer).s3, s3Mock.clients.at(-1)!, s3Mock.configs.at(-1)!)
	})
}
