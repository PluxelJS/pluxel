import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cache, CacheBackend, CachePlugin, MemoryCacheBackendPlugin } from '@pluxel/cache'
import { CanvasPlugin } from '@pluxel/canvas'
import { FontsPlugin } from '@pluxel/fonts'
import { OtelPlugin } from '@pluxel/otel'
import { MemoryRatesBackendPlugin, Rates, RatesBackend, RatesPlugin } from '@pluxel/rates'
import { createRuntimeTestHost } from '@pluxel/runtime/test'
import { S3, S3Plugin } from '@pluxel/storage'
import { WretchPlugin } from '@pluxel/wretch'
import { afterEach, describe, expect, it } from 'vitest'
import {
	CanvasShowcaseRenderer,
	ReleaseArchivePlugin,
	ReportStudioPlugin,
	ShowcaseRenderer,
} from './ReportStudio'

const temporaryRoots: string[] = []

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	)
})

describe('ReportStudioPlugin', () => {
	it('renders through selected providers, caches, and publishes to isolated S3 buckets', async () => {
		const storageRoot = await mkdtemp(join(tmpdir(), 'pluxel-report-studio-'))
		temporaryRoots.push(storageRoot)
		await using host = createRuntimeTestHost()
		await host.commit((change) => {
			change.catalog.add([
				MemoryCacheBackendPlugin,
				CachePlugin,
				MemoryRatesBackendPlugin,
				RatesPlugin,
				FontsPlugin,
				CanvasPlugin,
				CanvasShowcaseRenderer,
				S3Plugin,
				WretchPlugin,
				OtelPlugin,
				ReleaseArchivePlugin,
			])
			change.config.seed(S3Plugin, {
				buckets: [
					localStorageConfig('drafts', storageRoot, 'drafts'),
					localStorageConfig('releases', storageRoot, 'releases'),
				],
			})
			change.config.seed(OtelPlugin, {
				otlp: [],
				prometheus: { path: '/showcase/metrics' },
			})

			change.dependencies.setOverride({
				consumer: CachePlugin,
				requirement: CacheBackend,
				provider: MemoryCacheBackendPlugin,
			})
			change.dependencies.setOverride({
				consumer: RatesPlugin,
				requirement: RatesBackend,
				provider: MemoryRatesBackendPlugin,
			})
			change.dependencies.setOverride({
				consumer: ReportStudioPlugin,
				requirement: Cache,
				provider: CachePlugin,
			})
			change.dependencies.setOverride({
				consumer: ReportStudioPlugin,
				requirement: Rates,
				provider: RatesPlugin,
			})
			change.dependencies.setOverride({
				consumer: ReportStudioPlugin,
				requirement: ShowcaseRenderer,
				provider: CanvasShowcaseRenderer,
			})
			change.dependencies.setOverride({
				consumer: ReportStudioPlugin,
				requirement: S3,
				provider: S3Plugin,
			})
			change.dependencies.setOverride({
				consumer: ReleaseArchivePlugin,
				requirement: S3,
				provider: S3Plugin,
			})
			change.start(ReportStudioPlugin)
		})

		const studio = host.require(ReportStudioPlugin)
		const first = await studio.generate('Runtime graph')
		const second = await studio.generate('Runtime graph')
		expect(first.engine).toBe('canvas')
		expect(first.byteLength).toBeGreaterThan(100)
		expect(first).not.toHaveProperty('dataUrl')
		expect(first.cacheHit).toBe(false)
		expect(second.cacheHit).toBe(true)
		const storage = host.require(S3Plugin)
		expect(await storage.bucket('drafts').client.getObject(first.objectKey)).not.toBeNull()
		expect(
			await storage.bucket('releases').client.getObject(`releases/${first.id}.png`),
		).not.toBeNull()

		const status = await host.http.fetch(new URL('/showcase/status', host.http.origin))
		expect(status.status).toBe(200)
		const statusPayload = await status.json()
		expect(statusPayload).toMatchObject({
			rendererProvider: expect.stringContaining('CanvasShowcaseRenderer'),
			cache: { loads: 1, localHits: 1 },
		})
		expect(JSON.stringify(statusPayload)).not.toContain('data:image/png')
		const generated = await host.http.fetch(
			new URL('/showcase/generate/HTTP%20surface', host.http.origin),
			{ method: 'POST' },
		)
		expect(generated.status).toBe(200)
		await expect(generated.json()).resolves.toMatchObject({
			engine: 'canvas',
			cacheHit: false,
		})
		const artifact = await host.http.fetch(
			new URL(`/showcase/artifacts/${first.id}`, host.http.origin),
		)
		expect(artifact.status).toBe(200)
		expect(artifact.headers.get('content-type')).toBe('image/png')
		const artifactData = await artifact.arrayBuffer()
		expect(artifactData.byteLength).toBe(first.byteLength)
	})
})

function localStorageConfig(id: string, rootDir: string, bucketName: string) {
	return { id, backend: { type: 'local' as const, rootDir, bucketName, syncWrites: false } }
}
