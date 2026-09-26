import { assertWorkbenchDto, createWorkbenchWatch } from '@pluxel/workbench/server'
import { ElysiaApp } from '@pluxel/services/elysia'
import { Commands } from '@pluxel/services/commands'
import { Cache, type CacheNamespace, type CacheStats } from '@pluxel/cache'
import { CanvasPlugin } from '@pluxel/canvas'
import { defineCommand, Result } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'
import { EChartsPlugin } from '@pluxel/echarts'
import { OtelPlugin } from '@pluxel/otel'
import { Rates, type RateDecision, type RateLimiter } from '@pluxel/rates'
import { BasePlugin, formatPluginNodeReference, Plugin, PluginPart } from '@pluxel/core'
import * as f from 'valibot-form'
import * as v from 'valibot'
import { RpcTarget } from 'capnweb'
import { S3 } from '@pluxel/storage'
import { TakumiPlugin } from '@pluxel/takumi'
import { WretchPlugin } from '@pluxel/wretch'
import {
	ReportStudioWorkbench,
	type ReportStudioApi,
	type ShowcaseArtifact,
	type ShowcaseCacheStats,
	type ShowcaseObserver,
	type ShowcaseRendererKind,
	type ShowcaseSnapshot,
} from './ReportStudio.workbench'

const MAX_ARTIFACTS = 8
const MAX_TITLE_LENGTH = 80
const WIDTH = 720
const HEIGHT = 405

type RenderedPreview = Readonly<{
	engine: ShowcaseRendererKind
	mediaType: 'image/png'
	data: Uint8Array
}>

export abstract class ShowcaseRenderer extends BasePlugin {
	abstract kind(): ShowcaseRendererKind
	abstract render(title: string): Promise<RenderedPreview>
}

@Plugin(ShowcaseRenderer, { displayName: 'Showcase Renderer · ECharts' })
export class EChartsShowcaseRenderer extends ShowcaseRenderer {
	constructor(private readonly echarts: EChartsPlugin) {
		super()
	}

	kind(): ShowcaseRendererKind {
		return 'echarts'
	}

	async render(title: string): Promise<RenderedPreview> {
		const result = await this.echarts.render({
			width: WIDTH,
			height: HEIGHT,
			option: {
				animation: false,
				backgroundColor: '#10172a',
				title: { text: title, left: 'center', top: 24, textStyle: { color: '#f8fafc' } },
				grid: { left: 60, right: 36, top: 100, bottom: 48 },
				xAxis: {
					type: 'category',
					data: ['Catalog', 'Graph', 'Runtime', 'Workbench'],
					axisLabel: { color: '#cbd5e1' },
				},
				yAxis: { type: 'value', axisLabel: { color: '#cbd5e1' } },
				series: [
					{
						type: 'bar',
						data: [16, 12, 9, 7],
						itemStyle: { color: '#5eead4', borderRadius: [6, 6, 0, 0] },
					},
				],
			},
		})
		return Object.freeze({
			engine: 'echarts',
			mediaType: 'image/png',
			data: new Uint8Array(result.data),
		})
	}
}

@Plugin(ShowcaseRenderer, { displayName: 'Showcase Renderer · Takumi' })
export class TakumiShowcaseRenderer extends ShowcaseRenderer {
	constructor(private readonly takumi: TakumiPlugin) {
		super()
	}

	kind(): ShowcaseRendererKind {
		return 'takumi'
	}

	async render(title: string): Promise<RenderedPreview> {
		const result = await this.takumi.render({
			width: WIDTH,
			height: HEIGHT,
			content: `<div style="width:100%;height:100%;display:flex;flex-direction:column;justify-content:center;padding:56px;background:#10172a;color:#f8fafc"><div style="font-size:18px;color:#5eead4">PLUXEL REPORT STUDIO</div><div style="font-size:46px;font-weight:700;margin-top:18px">${escapeHtml(title)}</div><div style="font-size:20px;color:#94a3b8;margin-top:28px">Plugin graph → bounded renderer → named storage buckets</div></div>`,
		})
		return Object.freeze({
			engine: 'takumi',
			mediaType: 'image/png',
			data: new Uint8Array(result.data),
		})
	}
}

@Plugin(ShowcaseRenderer, { displayName: 'Showcase Renderer · Canvas' })
export class CanvasShowcaseRenderer extends ShowcaseRenderer {
	constructor(private readonly canvas: CanvasPlugin) {
		super()
	}

	kind(): ShowcaseRendererKind {
		return 'canvas'
	}

	async render(title: string): Promise<RenderedPreview> {
		const canvas = this.canvas.createCanvasSync(WIDTH, HEIGHT)
		const context = canvas.getContext('2d')
		context.fillStyle = '#10172a'
		context.fillRect(0, 0, WIDTH, HEIGHT)
		context.fillStyle = '#5eead4'
		context.fillRect(48, 48, 8, HEIGHT - 96)
		context.fillStyle = '#f8fafc'
		context.font = 'bold 42px sans-serif'
		context.fillText(title, 88, 185, WIDTH - 136)
		context.fillStyle = '#94a3b8'
		context.font = '20px sans-serif'
		context.fillText('Caller-owned native canvas with Fonts policy', 88, 235)
		return Object.freeze({
			engine: 'canvas',
			mediaType: 'image/png',
			data: new Uint8Array(canvas.toBuffer('image/png')),
		})
	}
}

const AdmissionConfig = v.object({
	limit: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)), 12),
		f.formMeta({ title: '生成次数', description: '每个限流窗口允许的 Workbench 生成次数' }),
	),
	windowMs: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1_000)), 60_000),
		f.formMeta({ title: '限流窗口 (ms)' }),
	),
})

class AdmissionPart extends PluginPart<ReportStudioPlugin> {
	private readonly config = this.configs.use(AdmissionConfig)
	private limiter?: RateLimiter

	constructor(private readonly rates: Rates) {
		super()
	}

	protected override init(): void {
		this.limiter = this.rates.use('report-generation', {
			algorithm: 'sliding-window-counter',
			limit: this.config.limit,
			windowMs: this.config.windowMs,
		})
	}

	consume(): Promise<RateDecision> {
		if (!this.limiter) throw new Error('AdmissionPart is not running')
		return this.limiter.consume('workbench')
	}

	providerReference(): string {
		return formatPluginNodeReference(this.rates.ctx.pluginInfo.nodeAddress)
	}
}

const RenderingConfig = v.object({
	cacheTtlMs: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 120_000),
		f.formMeta({ title: '预览缓存 TTL (ms)' }),
	),
})

class RenderingPart extends PluginPart<ReportStudioPlugin> {
	private readonly config = this.configs.use(RenderingConfig)
	private cache?: CacheNamespace

	constructor(
		private readonly renderer: ShowcaseRenderer,
		private readonly cacheProvider: Cache,
	) {
		super()
	}

	protected override init(): void {
		this.cache = this.cacheProvider.scope('previews', {
			ttlMs: this.config.cacheTtlMs,
			maxEntries: 32,
			maxInFlight: 4,
		})
	}

	async render(title: string): Promise<Readonly<{ preview: RenderedPreview; cacheHit: boolean }>> {
		const cache = this.requireCache()
		const before = cache.stats()
		const key = `${this.renderer.kind()}:${title}`
		const preview = await cache.getOrLoad<RenderedPreview>(key, () => this.renderer.render(title))
		const after = cache.stats()
		return Object.freeze({ preview, cacheHit: after.loads === before.loads })
	}

	providerReference(): string {
		return formatPluginNodeReference(this.renderer.ctx.pluginInfo.nodeAddress)
	}

	cacheProviderReference(): string {
		return formatPluginNodeReference(this.cacheProvider.ctx.pluginInfo.nodeAddress)
	}

	stats(): CacheStats {
		return this.requireCache().stats()
	}

	async clear(): Promise<CacheStats> {
		const cache = this.requireCache()
		await cache.clear()
		return cache.stats()
	}

	private requireCache(): CacheNamespace {
		if (!this.cache) throw new Error('RenderingPart is not running')
		return this.cache
	}
}

const PublishingConfig = v.object({
	prefix: v.pipe(v.optional(v.string(), 'drafts'), f.formMeta({ title: '草稿对象前缀' })),
})

class PublishingPart extends PluginPart<ReportStudioPlugin> {
	private readonly config = this.configs.use(PublishingConfig)

	constructor(private readonly storage: S3) {
		super()
	}

	async put(id: string, preview: RenderedPreview): Promise<string> {
		const key = `${this.config.prefix}/${id}.png`
		await this.storage
			.bucket('drafts')
			.client.putObject(key, Buffer.from(preview.data), preview.mediaType)
		return key
	}

	async read(key: string): Promise<ArrayBuffer | null> {
		return await this.storage.bucket('drafts').client.getObjectArrayBuffer(key)
	}

	providerReference(): string {
		return formatPluginNodeReference(this.storage.ctx.pluginInfo.nodeAddress)
	}
}

@Plugin({ displayName: 'Release Archive' })
export class ReleaseArchivePlugin extends BasePlugin {
	constructor(private readonly storage: S3) {
		super()
	}

	async archive(id: string, preview: RenderedPreview): Promise<string> {
		const key = `releases/${id}.png`
		await this.storage
			.bucket('releases')
			.client.putObject(key, Buffer.from(preview.data), preview.mediaType)
		return key
	}
}

const StudioConfig = v.object({
	outboundBaseUrl: v.pipe(
		v.optional(v.pipe(v.string(), v.url()), 'https://httpbingo.org'),
		f.formMeta({ title: '出站探测服务' }),
	),
	outboundPath: v.pipe(
		v.optional(v.pipe(v.string(), v.startsWith('/')), '/status/204'),
		f.formMeta({ title: '出站探测路径' }),
	),
})

@Plugin({ displayName: 'Report Studio · Architecture Lab' })
export class ReportStudioPlugin extends BasePlugin {
	private readonly config = this.configs.use(StudioConfig)
	private readonly admission = this.parts.use(AdmissionPart)
	private readonly rendering = this.parts.use(RenderingPart)
	private readonly publishing = this.parts.use(PublishingPart)
	private readonly listeners = new Set<(revision: number) => void>()
	private artifacts: ShowcaseArtifact[] = []
	private revision = 1
	private sequence = 1
	private lastRateDecision?: RateDecision
	private lastOutbound?: ShowcaseSnapshot['lastOutbound']
	private renderCounter?: Readonly<{
		add(value: number, attributes?: Record<string, string>): void
	}>
	private renderDuration?: Readonly<{
		record(value: number, attributes?: Record<string, string>): void
	}>

	constructor(
		private readonly http: WretchPlugin,
		private readonly otel: OtelPlugin,
		private readonly archive: ReleaseArchivePlugin,
	) {
		super()
	}

	protected override async init(): Promise<void> {
		await this.http.enableManagedSettings()
		const meter = this.otel.meter
		this.renderCounter = meter.createCounter('showcase.report.generated', { unit: '{report}' })
		this.renderDuration = meter.createHistogram('showcase.report.duration', { unit: 'ms' })

		this.ctx.require(Commands).register(
			defineCommand({
				name: 'showcase.report.generate',
				description: 'Render, cache and publish one Report Studio preview.',
				input: obj({ title: Type.String({ minLength: 1, maxLength: MAX_TITLE_LENGTH }) }),
				execute: async ({ title }) => {
					const artifact = await this.generate(title)
					return Result.ok(pickCommandArtifact(artifact))
				},
			}),
		)
		this.ctx.require(Commands).register(
			defineCommand({
				name: 'showcase.cache.clear',
				description: 'Clear the Report Studio caller-owned preview cache.',
				input: obj({}),
				execute: async () => {
					await this.clearCache()
					return Result.ok()
				},
			}),
		)

		this.ctx
			.require(ElysiaApp)
			.get('/showcase/status', () => compactSnapshot(this.snapshot()))
			.post('/showcase/generate/:title', async ({ params }) =>
				pickCommandArtifact(await this.generate(params.title)),
			)
			.get('/showcase/artifacts/:id', async ({ params, set }) => {
				const artifact = this.artifacts.find((candidate) => candidate.id === params.id)
				if (!artifact) {
					set.status = 404
					return { error: 'artifact_not_found' }
				}
				const data = await this.publishing.read(artifact.objectKey)
				if (!data) {
					set.status = 404
					return { error: 'object_not_found' }
				}
				return new Response(data, { headers: { 'content-type': artifact.mediaType } })
			})

		this.ctx.workbench?.publish(ReportStudioWorkbench, {
			studio: ({ signal }) => new ReportStudioTarget(this, signal),
			httpSettings: { provider: this.http },
		})
	}

	snapshot(): ShowcaseSnapshot {
		return Object.freeze({
			revision: this.revision,
			rendererProvider: this.rendering.providerReference(),
			storageProvider: this.publishing.providerReference(),
			cacheProvider: this.rendering.cacheProviderReference(),
			ratesProvider: this.admission.providerReference(),
			cache: cacheStats(this.rendering.stats()),
			...(this.lastRateDecision
				? { lastRateDecision: Object.freeze({ ...this.lastRateDecision }) }
				: {}),
			artifacts: Object.freeze(this.artifacts.map((artifact) => Object.freeze({ ...artifact }))),
			...(this.lastOutbound ? { lastOutbound: Object.freeze({ ...this.lastOutbound }) } : {}),
		})
	}

	async generate(input: string): Promise<ShowcaseArtifact> {
		const title = normalizeTitle(input)
		const decision = await this.admission.consume()
		this.lastRateDecision = decision
		if (decision.denied) {
			this.changed()
			throw new Error(`Report generation is rate limited; retry in ${decision.retryAfterMs}ms`)
		}

		const started = performance.now()
		const { preview, cacheHit } = await this.rendering.render(title)
		const id = `${Date.now().toString(36)}-${this.sequence++}`
		const objectKey = await this.publishing.put(id, preview)
		await this.archive.archive(id, preview)
		const artifact = Object.freeze({
			id,
			title,
			engine: preview.engine,
			mediaType: preview.mediaType,
			byteLength: preview.data.byteLength,
			objectKey,
			createdAt: Date.now(),
			cacheHit,
		}) satisfies ShowcaseArtifact
		this.artifacts = [...this.artifacts, artifact].slice(-MAX_ARTIFACTS)
		this.renderCounter?.add(1, { engine: preview.engine, cache_hit: String(cacheHit) })
		this.renderDuration?.record(performance.now() - started, { engine: preview.engine })
		this.changed()
		return artifact
	}

	async probeOutbound(): Promise<NonNullable<ShowcaseSnapshot['lastOutbound']>> {
		try {
			const response = await this.http.client
				.url(this.config.outboundBaseUrl, true)
				.get(this.config.outboundPath)
				.res()
			this.lastOutbound = Object.freeze({
				ok: response.ok,
				status: response.status,
				at: Date.now(),
				message: `${response.status} ${response.statusText || 'HTTP response'}`,
			})
		} catch (error) {
			this.lastOutbound = Object.freeze({
				ok: false,
				at: Date.now(),
				message: error instanceof Error ? error.message : String(error),
			})
		}
		this.changed()
		return this.lastOutbound
	}

	async clearCache(): Promise<ShowcaseCacheStats> {
		const stats = cacheStats(await this.rendering.clear())
		this.changed()
		return stats
	}

	subscribe(listener: (revision: number) => void): Disposable {
		this.listeners.add(listener)
		let active = true
		return Object.freeze({
			[Symbol.dispose]: () => {
				if (!active) return
				active = false
				this.listeners.delete(listener)
			},
		})
	}

	private changed(): void {
		this.revision += 1
		const listeners = Array.from(this.listeners)
		for (const listener of listeners) listener(this.revision)
	}
}

class ReportStudioTarget extends RpcTarget implements ReportStudioApi {
	constructor(
		private readonly studio: ReportStudioPlugin,
		private readonly signal: AbortSignal,
	) {
		super()
	}

	snapshotDto(): ShowcaseSnapshot {
		const snapshot = this.studio.snapshot()
		assertWorkbenchDto(snapshot)
		return snapshot
	}

	watch(observer: ShowcaseObserver): RpcTarget {
		return createWorkbenchWatch({
			observer,
			signal: this.signal,
			subscribe: (notify) => this.studio.subscribe(notify),
		})
	}

	async generateDto(title: string): Promise<ShowcaseArtifact> {
		const result = await this.studio.generate(title)
		assertWorkbenchDto(result)
		return result
	}

	async probeOutboundDto(): Promise<NonNullable<ShowcaseSnapshot['lastOutbound']>> {
		const result = await this.studio.probeOutbound()
		assertWorkbenchDto(result)
		return result
	}

	async clearCacheDto(): Promise<ShowcaseCacheStats> {
		const result = await this.studio.clearCache()
		assertWorkbenchDto(result)
		return result
	}
}

function normalizeTitle(input: string): string {
	if (typeof input !== 'string') throw new TypeError('title must be a string')
	const title = input.trim()
	if (!title) throw new TypeError('title must not be empty')
	if (title.length > MAX_TITLE_LENGTH) {
		throw new RangeError(`title must not exceed ${MAX_TITLE_LENGTH} UTF-16 code units`)
	}
	return title
}

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;')
}

function cacheStats(stats: CacheStats): ShowcaseCacheStats {
	return Object.freeze({
		localHits: stats.localHits,
		backendHits: stats.backendHits,
		misses: stats.misses,
		loads: stats.loads,
		deduplicated: stats.deduplicated,
		entries: stats.entries,
	})
}

function compactSnapshot(snapshot: ShowcaseSnapshot) {
	return {
		revision: snapshot.revision,
		rendererProvider: snapshot.rendererProvider,
		storageProvider: snapshot.storageProvider,
		cache: snapshot.cache,
		artifacts: snapshot.artifacts.map(pickCommandArtifact),
	}
}

function pickCommandArtifact(artifact: ShowcaseArtifact) {
	return {
		id: artifact.id,
		engine: artifact.engine,
		byteLength: artifact.byteLength,
		objectKey: artifact.objectKey,
		cacheHit: artifact.cacheHit,
	}
}
