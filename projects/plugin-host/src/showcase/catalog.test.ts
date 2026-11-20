import { Cache, CacheBackend, CachePlugin, MemoryCacheBackendPlugin } from '@pluxel/plugin-cache'
import { MemoryRatesBackendPlugin, Rates, RatesBackend, RatesPlugin } from '@pluxel/plugin-rates'
import { RedisCacheBackendPlugin, RedisPlugin, RedisRatesBackendPlugin } from '@pluxel/plugin-redis'
import { S3, S3Plugin } from '@pluxel/plugin-storage'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import application from '../app'
import { ReportStudioPlugin } from './ReportStudio'

let declaration: Awaited<ReturnType<typeof application>>
beforeAll(async () => {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-showcase-catalog-'))
	try {
		declaration = await application({
			root,
			mode: 'test',
			env: { PLUXEL_WORKBENCH: 'false', PLUXEL_DATA_ROOT: root },
			bindings: {},
		})
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

describe('plugin-host catalog', () => {
	it('selects safe in-memory implementations without auto-starting Redis', () => {
		for (const plugin of [RedisPlugin, RedisCacheBackendPlugin, RedisRatesBackendPlugin]) {
			const entry = declaration.plugins?.find((candidate) => candidate.plugin === plugin)
			expect(entry).toBeDefined()
			expect(entry?.autoStart).toBeUndefined()
		}
		expect(declaration.policy?.providerDefaults).toEqual(
			expect.arrayContaining([
				{ token: Cache.address(), provider: CachePlugin.nodeAddress() },
				{ token: CacheBackend.address(), provider: MemoryCacheBackendPlugin.nodeAddress() },
				{ token: Rates.address(), provider: RatesPlugin.nodeAddress() },
				{ token: RatesBackend.address(), provider: MemoryRatesBackendPlugin.nodeAddress() },
			]),
		)
	})

	it('prepares one S3 provider with isolated draft and release buckets', () => {
		expect(declaration.policy?.providerDefaults).toContainEqual({
			token: S3.address(),
			provider: S3Plugin.nodeAddress(),
		})
		const s3 = declaration.plugins?.filter((entry) => entry.plugin === S3Plugin)
		expect(s3).toHaveLength(1)
		expect(s3?.[0]).toMatchObject({
			autoStart: true,
			config: {
				buckets: [
					{ id: 'drafts', backend: { bucketName: 'draft-previews' } },
					{ id: 'releases', backend: { bucketName: 'released-reports' } },
				],
			},
		})
		expect(
			declaration.plugins?.filter((entry) => entry.plugin === ReportStudioPlugin),
		).toHaveLength(1)
	})
})
