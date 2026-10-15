import { standardServices } from '@pluxel/services'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cache, CacheBackend, CachePlugin, MemoryCacheBackendPlugin } from '@pluxel/cache'
import { CanvasPlugin } from '@pluxel/canvas'
import { EChartsPlugin } from '@pluxel/echarts'
import { TakumiPlugin } from '@pluxel/takumi'
import { TakumiMarkdownPlugin } from '@pluxel/takumi-markdown'
import { TypstPlugin } from '@pluxel/typst'
import { FontsPlugin } from '@pluxel/fonts'
import { OtelPlugin } from '@pluxel/otel'
import { MemoryRatesBackendPlugin, Rates, RatesBackend, RatesPlugin } from '@pluxel/rates'
import { createTestHost } from '@pluxel/test'
import { S3, S3Plugin } from '@pluxel/storage'
import { WretchPlugin } from '@pluxel/wretch'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReportStudioWorkbench } from './ReportStudio.workbench'
import { ReportStudioPlugin } from './ReportStudio'
import { SHOWCASE_ENGINES } from './ReportStudio.contracts'

const temporaryRoots: string[] = []

afterEach(async () => {
	vi.restoreAllMocks()
	await Promise.all(
		temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	)
})

describe('ReportStudioPlugin', () => {
	it('selects all six renderers in one plugin, caches by engine, and publishes PNG/SVG to isolated buckets', async () => {
		const mainThreadRender = vi.spyOn(TakumiPlugin.prototype, 'render').mockImplementation(() => {
			throw new Error('Report templates must execute in the shared Workers service')
		})
		const compileMath = vi.spyOn(TypstPlugin.prototype, 'renderSvg')
		const storageRoot = await mkdtemp(join(tmpdir(), 'pluxel-report-studio-'))
		temporaryRoots.push(storageRoot)
		await using host = await createTestHost({
			workbench: true,
			services: standardServices({ persistence: { mode: 'memory' } }),
		})
		await host.commit((change) => {
			change.catalog.add([
				MemoryCacheBackendPlugin,
				CachePlugin,
				MemoryRatesBackendPlugin,
				RatesPlugin,
				FontsPlugin,
				CanvasPlugin,
				EChartsPlugin,
				TakumiPlugin,
				TakumiMarkdownPlugin,
				TypstPlugin,
				S3Plugin,
				WretchPlugin,
				OtelPlugin,
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
				requirement: S3,
				provider: S3Plugin,
			})
			change.start(ReportStudioPlugin)
		})

		const studio = host.require(ReportStudioPlugin)
		const subscribe = studio.subscribe.bind(studio)
		const releasePanelSubscriptions = vi.fn()
		const subscriptionSpy = vi.spyOn(studio, 'subscribe').mockImplementation((listener) => {
			const subscription = subscribe(listener)
			return {
				[Symbol.dispose]: () => {
					releasePanelSubscriptions()
					subscription[Symbol.dispose]()
				},
			}
		})
		const principal = { provider: 'test', subject: 'report-panels' }
		using statusPanel = await host.workbench.open({
			target: ReportStudioPlugin,
			entry: ReportStudioWorkbench.studioStatus,
			principal,
		})
		using artifactsPanel = await host.workbench.open({
			target: ReportStudioPlugin,
			entry: ReportStudioWorkbench.studioArtifacts,
			principal,
		})
		const statusObserver = vi.fn(() => undefined)
		const artifactsObserver = vi.fn(() => undefined)
		await expect(statusPanel.root.subscribeDto(statusObserver)).resolves.toMatchObject({
			ok: true,
			data: { status: { cacheHits: 0, cacheMisses: 0 } },
		})
		await expect(artifactsPanel.root.subscribeDto(artifactsObserver)).resolves.toMatchObject({
			ok: true,
			data: { artifacts: [] },
		})
		using studioView = await host.workbench.open({
			target: ReportStudioPlugin,
			entry: ReportStudioWorkbench.studio,
			location: '/architecture-lab',
			principal,
		})
		const first = await studioView.api.generateDto({ title: 'Runtime graph', engine: 'canvas' })
		const second = await studio.generate({ title: 'Runtime graph', engine: 'canvas' })
		expect(first.engine).toBe('canvas')
		expect(first.byteLength).toBeGreaterThan(100)
		expect(first).not.toHaveProperty('dataUrl')
		expect(first.cacheHit).toBe(false)
		expect(second.cacheHit).toBe(true)
		await expect(statusPanel.root.loadDto()).resolves.toMatchObject({
			ok: true,
			data: { status: { cacheHits: 1, cacheMisses: 1 } },
		})
		await expect(artifactsPanel.root.loadDto()).resolves.toMatchObject({
			ok: true,
			data: {
				artifacts: [
					{ title: 'Runtime graph', cacheHit: true },
					{ title: 'Runtime graph', cacheHit: false },
				],
			},
		})
		statusPanel[Symbol.dispose]()
		artifactsPanel[Symbol.dispose]()
		expect(releasePanelSubscriptions).toHaveBeenCalledTimes(2)
		subscriptionSpy.mockRestore()
		const storage = host.require(S3Plugin)
		expect(await storage.bucket('drafts').client.getObject(first.objectKey)).not.toBeNull()
		expect(
			await storage.bucket('releases').client.getObject(`releases/${first.id}.png`),
		).not.toBeNull()

		const status = await host.http.fetch(new URL('/showcase/status', host.http.origin))
		expect(status.status).toBe(200)
		const statusPayload = await status.json()
		expect(statusPayload).toMatchObject({
			engines: SHOWCASE_ENGINES,
			renderingProviders: { canvas: expect.stringContaining('CanvasPlugin') },
			cache: { loads: 1, localHits: 1 },
		})
		expect(JSON.stringify(statusPayload)).not.toContain('data:image/png')
		const generated = await host.http.fetch(
			new URL('/showcase/generate/canvas/HTTP%20surface', host.http.origin),
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
		const onGenerated = vi.fn()
		const unsubscribe = studio.generated.on(onGenerated)
		try {
			for (const engine of SHOWCASE_ENGINES.filter(
				(candidate) => candidate !== 'canvas' && candidate !== 'typst',
			)) {
				const output = await studio.generate({ title: 'Runtime graph', engine })
				expect(output.engine).toBe(engine)
				expect(output.cacheHit).toBe(false)
				expect(output.byteLength).toBeGreaterThan(100)
				expect(output.mediaType).toBe('image/png')
				const response = await host.http.fetch(
					new URL(`/showcase/artifacts/${output.id}`, host.http.origin),
				)
				expect(response.status).toBe(200)
				const bytes = new Uint8Array(await response.arrayBuffer())
				expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
			}
			expect(mainThreadRender).not.toHaveBeenCalled()
			expect(compileMath).toHaveBeenCalledTimes(2)
			expect(compileMath.mock.calls[0]?.[0]).toContain('a^2 + b^2 = c^2')
			expect(compileMath.mock.calls[1]?.[0]).toContain('sum_(i=1)^n i')
			const typeset = await studio.generate({ title: 'Runtime graph', engine: 'typst' })
			expect(typeset.mediaType).toBe('image/svg+xml')
			expect(typeset.objectKey).toMatch(/\.svg$/)
			const svgResponse = await host.http.fetch(
				new URL(`/showcase/artifacts/${typeset.id}`, host.http.origin),
			)
			expect(svgResponse.status).toBe(200)
			expect(await svgResponse.text()).toContain('<svg')

			expect(onGenerated).toHaveBeenCalledTimes(5)
		} finally {
			unsubscribe()
		}
		await expect(studio.generate({ title: '', engine: 'canvas' })).rejects.toThrow(
			'title must not be empty',
		)
	}, 45_000)
})

function localStorageConfig(id: string, rootDir: string, bucketName: string) {
	return { id, backend: { type: 'local' as const, rootDir, bucketName, syncWrites: false } }
}
