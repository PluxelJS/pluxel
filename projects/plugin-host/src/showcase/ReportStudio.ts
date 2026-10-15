import { assertWorkbenchDto, createWorkbenchWatch } from '@pluxel/workbench/server'
import { ElysiaApp } from '@pluxel/services/elysia'
import { Commands } from '@pluxel/services/commands'
import { Workers, defineWorkerTask } from '@pluxel/services/workers'
import { Cache, type CacheNamespace, type CacheStats } from '@pluxel/cache'
import { CanvasPlugin } from '@pluxel/canvas'
import { FontsPlugin, type PortableFontsSnapshot } from '@pluxel/fonts'
import { defineCommand, Result } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'
import { EChartsPlugin } from '@pluxel/echarts'
import { OtelPlugin } from '@pluxel/otel'
import { Rates, type RateDecision, type RateLimiter } from '@pluxel/rates'
import { BasePlugin, EvtChannel, formatPluginNodeReference, Plugin } from '@pluxel/core'
import * as f from 'valibot-form'
import * as v from 'valibot'
import { RpcTarget } from 'capnweb'
import { S3 } from '@pluxel/storage'
import { TakumiPlugin } from '@pluxel/takumi'
import { TakumiMarkdownPlugin, type MarkdownRenderer } from '@pluxel/takumi-markdown'
import { TypstPlugin } from '@pluxel/typst'
import type { ReportFont, ReportRenderInput } from './report-render.contracts'
import { SHOWCASE_ENGINES, type ShowcaseRenderRequest } from './ReportStudio.contracts'
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
const renderTask = defineWorkerTask<ReportRenderInput, Uint8Array>(
	import.meta.url,
	'./report-render.task.tsx',
)

type RenderedPreview = Readonly<{
	engine: ShowcaseRendererKind
	mediaType: 'image/png' | 'image/svg+xml'
	data: Uint8Array
}>

const StudioConfig = v.object({
	admission: v.optional(
		v.object({
			limit: v.pipe(
				v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)), 12),
				f.formMeta({ title: '生成次数' }),
			),
			windowMs: v.pipe(
				v.optional(v.pipe(v.number(), v.integer(), v.minValue(1_000)), 60_000),
				f.formMeta({ title: '限流窗口 (ms)' }),
			),
		}),
		{},
	),
	cacheTtlMs: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 120_000),
		f.formMeta({ title: '预览缓存 TTL (ms)' }),
	),
	draftPrefix: v.pipe(v.optional(v.string(), 'drafts'), f.formMeta({ title: '草稿对象前缀' })),
	releasePrefix: v.pipe(v.optional(v.string(), 'releases'), f.formMeta({ title: '发布对象前缀' })),
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
	readonly generated = new EvtChannel<readonly [artifact: ShowcaseArtifact]>(this.ctx)
	private cache?: CacheNamespace
	private limiter?: RateLimiter
	private markdownRenderer?: MarkdownRenderer
	private fontSnapshot?: Readonly<{
		provider: FontsPlugin
		revision: number
		data: Promise<readonly ReportFont[]>
	}>
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
		private readonly cacheProvider: Cache,
		private readonly rates: Rates,
		private readonly storage: S3,
		private readonly canvas: CanvasPlugin,
		private readonly echarts: EChartsPlugin,
		private readonly takumi: TakumiPlugin,
		private readonly markdown: TakumiMarkdownPlugin,
		private readonly typst: TypstPlugin,
		private readonly fonts: FontsPlugin,
	) {
		super()
	}

	protected override async init(): Promise<void> {
		this.cache = this.cacheProvider.scope('previews', {
			ttlMs: this.config.cacheTtlMs,
			maxEntries: 32,
			maxInFlight: 4,
		})
		this.limiter = this.rates.use('report-generation', {
			algorithm: 'sliding-window-counter',
			limit: this.config.admission.limit,
			windowMs: this.config.admission.windowMs,
		})
		const markdownRenderer = this.markdown.createRenderer({ theme: 'dark' })
		this.markdownRenderer = markdownRenderer
		this.ctx.effects.defer(() => markdownRenderer.close())
		await this.http.enableManagedSettings()
		const meter = this.otel.meter
		this.renderCounter = meter.createCounter('showcase.report.generated', { unit: '{report}' })
		this.renderDuration = meter.createHistogram('showcase.report.duration', { unit: 'ms' })

		this.ctx.require(Commands).register(
			defineCommand({
				name: 'showcase.report.generate',
				description: 'Render, cache and publish one Report Studio preview.',
				input: obj({
					title: Type.String({ minLength: 1, maxLength: MAX_TITLE_LENGTH }),
					engine: Type.Union(SHOWCASE_ENGINES.map((engine) => Type.Literal(engine))),
				}),
				execute: async (request) => {
					const artifact = await this.generate(request)
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
			.post('/showcase/generate/:engine/:title', async ({ params }) =>
				pickCommandArtifact(
					await this.generate({ title: params.title, engine: parseEngine(params.engine) }),
				),
			)
			.get('/showcase/artifacts/:id', async ({ params, set }) => {
				const artifact = this.artifacts.find((candidate) => candidate.id === params.id)
				if (!artifact) {
					set.status = 404
					return { error: 'artifact_not_found' }
				}
				const data = await this.storage
					.bucket('drafts')
					.client.getObjectArrayBuffer(artifact.objectKey)
				if (!data) {
					set.status = 404
					return { error: 'object_not_found' }
				}
				return new Response(data, { headers: { 'content-type': artifact.mediaType } })
			})

		this.ctx.workbench?.publish(ReportStudioWorkbench, {
			studio: ({ signal }) => new ReportStudioTarget(this, signal),
			studioStatus: ({ signal, dataChanged }) => {
				const subscription = this.subscribe(dataChanged)
				const release = () => subscription[Symbol.dispose]()
				signal.addEventListener('abort', release, { once: true })
				if (signal.aborted) release()
				return {
					load: () => {
						const snapshot = this.snapshot()
						return {
							status: {
								renderer: snapshot.engines.join(' · '),
								storage: snapshot.storageProvider,
								cacheHits: snapshot.cache.localHits + snapshot.cache.backendHits,
								cacheMisses: snapshot.cache.misses,
								cacheEntries: snapshot.cache.entries,
							},
						}
					},
				}
			},
			studioArtifacts: ({ signal, dataChanged }) => {
				const subscription = this.subscribe(dataChanged)
				const release = () => subscription[Symbol.dispose]()
				signal.addEventListener('abort', release, { once: true })
				if (signal.aborted) release()
				return {
					load: () => ({
						artifacts: this.snapshot()
							.artifacts.toReversed()
							.map((artifact) => ({
								title: artifact.title,
								engine: artifact.engine,
								bytes: artifact.byteLength,
								cacheHit: artifact.cacheHit,
							})),
					}),
				}
			},
			httpSettings: { provider: this.http },
		})
	}

	snapshot(): ShowcaseSnapshot {
		return Object.freeze({
			revision: this.revision,
			engines: SHOWCASE_ENGINES,
			renderingProviders: Object.freeze({
				echarts: reference(this.echarts),
				canvas: reference(this.canvas),
				takumi: reference(this.takumi),
				heroui: reference(this.takumi),
				markdown: reference(this.markdown),
				typst: reference(this.typst),
			}),
			storageProvider: reference(this.storage),
			cacheProvider: reference(this.cacheProvider),
			ratesProvider: reference(this.rates),
			cache: cacheStats(this.requireCache().stats()),
			...(this.lastRateDecision
				? { lastRateDecision: Object.freeze({ ...this.lastRateDecision }) }
				: {}),
			artifacts: Object.freeze(this.artifacts.map((artifact) => Object.freeze({ ...artifact }))),
			...(this.lastOutbound ? { lastOutbound: Object.freeze({ ...this.lastOutbound }) } : {}),
		})
	}

	async generate(input: ShowcaseRenderRequest): Promise<ShowcaseArtifact> {
		const title = normalizeTitle(input.title)
		const engine = parseEngine(input.engine)
		if (!this.limiter) throw new Error('Report Studio is not running')
		const decision = await this.limiter.consume('workbench')
		this.lastRateDecision = decision
		if (decision.denied) {
			this.changed()
			throw new Error(`Report generation is rate limited; retry in ${decision.retryAfterMs}ms`)
		}

		const started = performance.now()
		const fonts = this.fonts.portableFonts
		let loaded = false
		const preview = await this.requireCache().getOrLoad<RenderedPreview>(
			`${engine}:${this.fonts.revision}:${title}`,
			() => {
				loaded = true
				return this.renderPreview(title, engine, fonts)
			},
		)
		const cacheHit = !loaded
		const id = `${Date.now().toString(36)}-${this.sequence++}`
		const extension = preview.mediaType === 'image/svg+xml' ? 'svg' : 'png'
		const objectKey = `${this.config.draftPrefix}/${id}.${extension}`
		await this.storage
			.bucket('drafts')
			.client.putObject(objectKey, Buffer.from(preview.data), preview.mediaType)
		await this.storage
			.bucket('releases')
			.client.putObject(
				`${this.config.releasePrefix}/${id}.${extension}`,
				Buffer.from(preview.data),
				preview.mediaType,
			)
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
		this.generated.emit(artifact)
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
		const cache = this.requireCache()
		await cache.clear()
		const stats = cacheStats(cache.stats())
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

	private async renderPreview(
		title: string,
		engine: ShowcaseRendererKind,
		fontResources: PortableFontsSnapshot,
	): Promise<RenderedPreview> {
		if (engine === 'typst') {
			const source = `#set page(width: ${WIDTH}pt, height: ${HEIGHT}pt, margin: 40pt, fill: rgb("#10172a"))
#set text(fill: rgb("#f8fafc"), size: 18pt)
#text(fill: rgb("#5eead4"))[PLUXEL REPORT STUDIO]
#v(24pt)
#text(size: 36pt, weight: "bold", ${JSON.stringify(title)})
#v(24pt)
Typst document rendering · shared worker
#v(24pt)
$ sum_(i=1)^n i = (n(n+1))/2 $`
			return { engine, mediaType: 'image/svg+xml', data: await this.typst.renderSvg(source) }
		}
		if (engine === 'canvas') {
			const canvas = this.canvas.createCanvasSync(WIDTH, HEIGHT)
			const context = canvas.getContext('2d')
			context.fillStyle = '#10172a'
			context.fillRect(0, 0, WIDTH, HEIGHT)
			context.fillStyle = '#5eead4'
			context.fillRect(48, 48, 8, HEIGHT - 96)
			context.fillStyle = '#f8fafc'
			context.font = 'bold 38px sans-serif'
			context.fillText(title, 88, 185, WIDTH - 136)
			context.fillStyle = '#94a3b8'
			context.font = '18px sans-serif'
			context.fillText('Native Canvas · shared Fonts registry', 88, 235)
			return { engine, mediaType: 'image/png', data: new Uint8Array(canvas.toBuffer('image/png')) }
		}
		if (engine === 'echarts') {
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
			return { engine, mediaType: 'image/png', data: new Uint8Array(result.data) }
		}
		const fonts = await this.readFonts(fontResources)
		const options = { width: WIDTH, height: HEIGHT, fonts, format: 'png' as const }
		if (engine === 'markdown') {
			if (!this.markdownRenderer) throw new Error('Report Studio is not running')
			const source = `# ${title.replaceAll(/[\\`*_[\]<>#]/g, '\\$&')}

**Pluxel Report Studio** · Markdown and Typst math

Inline math: $a^2 + b^2 = c^2$.

$$
sum_(i=1)^n i = (n(n+1))/2
$$

> Typst compiles formulas; Takumi renders the report in shared Workers.`
			return {
				engine,
				mediaType: 'image/png',
				data: await this.markdownRenderer.render(source, options),
			}
		}
		return {
			engine,
			mediaType: 'image/png',
			// The font snapshot belongs to this generation and is never mutated. Borrow it until
			// execution settles, avoiding an extra admission-time copy of the shared font bytes.
			data: await this.ctx
				.require(Workers)
				.run(
					renderTask,
					{ title, engine, fonts },
					{ inputOwnership: 'borrowed', settlement: 'execution' },
				),
		}
	}

	private readFonts(resources: PortableFontsSnapshot): Promise<readonly ReportFont[]> {
		if (
			this.fontSnapshot?.provider === this.fonts &&
			this.fontSnapshot.revision === resources.revision
		)
			return this.fontSnapshot.data
		const data = Promise.all(
			resources.fonts.map(async (font) =>
				Object.freeze({
					data: await this.fonts.readPortableFont(font.id),
					...(font.family ? { name: font.family } : {}),
				}),
			),
		).then((fonts) => Object.freeze(fonts))
		const snapshot = { provider: this.fonts, revision: resources.revision, data }
		this.fontSnapshot = snapshot
		void data.catch(() => {
			if (this.fontSnapshot === snapshot) this.fontSnapshot = undefined
		})
		return data
	}

	private requireCache(): CacheNamespace {
		if (!this.cache) throw new Error('Report Studio is not running')
		return this.cache
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

	async generateDto(request: ShowcaseRenderRequest): Promise<ShowcaseArtifact> {
		const result = await this.studio.generate(request)
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

function parseEngine(value: string): ShowcaseRendererKind {
	if (!SHOWCASE_ENGINES.includes(value as ShowcaseRendererKind)) {
		throw new TypeError(`Unknown rendering engine: ${value}`)
	}
	return value as ShowcaseRendererKind
}

function reference(plugin: BasePlugin): string {
	return formatPluginNodeReference(plugin.ctx.pluginInfo.nodeAddress)
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
		engines: snapshot.engines,
		renderingProviders: snapshot.renderingProviders,
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
