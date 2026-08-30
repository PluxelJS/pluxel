import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cache, CacheBackend, CachePlugin, MemoryCacheBackendPlugin } from '@pluxel/cache'
import { CanvasPlugin } from '@pluxel/canvas'
import { FontsPlugin } from '@pluxel/fonts'
import { OtelPlugin } from '@pluxel/otel'
import { MemoryRatesBackendPlugin, Rates, RatesBackend, RatesPlugin } from '@pluxel/rates'
import { pluginDefinitionAddressOf, pluginNodeAddressOf } from '@pluxel/runtime'
import { createRuntimeHost } from '@pluxel/runtime/test'
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
	it('renders through selected providers, caches, and publishes to isolated S3 forks', async () => {
		const storageRoot = await mkdtemp(join(tmpdir(), 'pluxel-report-studio-'))
		temporaryRoots.push(storageRoot)
		const host = createRuntimeHost()
		try {
			host.add([
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
				ReportStudioPlugin,
			])
			const drafts = host.fork(S3Plugin, 'drafts')
			const releases = host.fork(S3Plugin, 'releases')
			host.cfg(drafts).set(localStorageConfig(storageRoot, 'drafts'))
			host.cfg(releases).set(localStorageConfig(storageRoot, 'releases'))
			host.cfg(OtelPlugin).set({ otlp: [], prometheus: { path: '/showcase/metrics' } })

			host.override(
				CachePlugin,
				pluginDefinitionAddressOf(CacheBackend),
				pluginNodeAddressOf(MemoryCacheBackendPlugin),
			)
			host.override(
				RatesPlugin,
				pluginDefinitionAddressOf(RatesBackend),
				pluginNodeAddressOf(MemoryRatesBackendPlugin),
			)
			host.override(
				ReportStudioPlugin,
				pluginDefinitionAddressOf(Cache),
				pluginNodeAddressOf(CachePlugin),
			)
			host.override(
				ReportStudioPlugin,
				pluginDefinitionAddressOf(Rates),
				pluginNodeAddressOf(RatesPlugin),
			)
			host.override(
				ReportStudioPlugin,
				pluginDefinitionAddressOf(ShowcaseRenderer),
				pluginNodeAddressOf(CanvasShowcaseRenderer),
			)
			host.override(ReportStudioPlugin, pluginDefinitionAddressOf(S3), drafts)
			host.override(ReleaseArchivePlugin, pluginDefinitionAddressOf(S3), releases)
			host.start(ReportStudioPlugin)
			await host.commit()

			const studio = host.require(ReportStudioPlugin)
			const first = await studio.generate('Runtime graph')
			const second = await studio.generate('Runtime graph')
			expect(first.engine).toBe('canvas')
			expect(first.byteLength).toBeGreaterThan(100)
			expect(first).not.toHaveProperty('dataUrl')
			expect(first.cacheHit).toBe(false)
			expect(second.cacheHit).toBe(true)
			expect(await host.require(drafts).client.getObject(first.objectKey)).not.toBeNull()
			expect(
				await host.require(releases).client.getObject(`releases/${first.id}.png`),
			).not.toBeNull()

			const status = await host.fetch(new Request('http://local.test/showcase/status'))
			expect(status.status).toBe(200)
			const statusPayload = await status.json()
			expect(statusPayload).toMatchObject({
				rendererProvider: expect.stringContaining('CanvasShowcaseRenderer'),
				cache: { loads: 1, localHits: 1 },
			})
			expect(JSON.stringify(statusPayload)).not.toContain('data:image/png')
			const generated = await host.fetch(
				new Request('http://local.test/showcase/generate/HTTP%20surface', { method: 'POST' }),
			)
			expect(generated.status).toBe(200)
			await expect(generated.json()).resolves.toMatchObject({
				engine: 'canvas',
				cacheHit: false,
			})
			const artifact = await host.fetch(
				new Request(`http://local.test/showcase/artifacts/${first.id}`),
			)
			expect(artifact.status).toBe(200)
			expect(artifact.headers.get('content-type')).toBe('image/png')
			const artifactData = await artifact.arrayBuffer()
			expect(artifactData.byteLength).toBe(first.byteLength)
		} finally {
			await host.dispose()
		}
	})
})

function localStorageConfig(rootDir: string, bucketName: string) {
	return { backend: { type: 'local' as const, rootDir, bucketName, syncWrites: false } }
}
