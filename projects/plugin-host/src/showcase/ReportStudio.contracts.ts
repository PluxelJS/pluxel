import type { RpcTarget } from 'capnweb'

export const SHOWCASE_ENGINES = [
	'echarts',
	'canvas',
	'takumi',
	'heroui',
	'markdown',
	'typst',
] as const
export type ShowcaseRendererKind = (typeof SHOWCASE_ENGINES)[number]
export type ShowcaseRenderRequest = Readonly<{ title: string; engine: ShowcaseRendererKind }>

export type ShowcaseArtifact = Readonly<{
	id: string
	title: string
	engine: ShowcaseRendererKind
	mediaType: 'image/png' | 'image/svg+xml'
	byteLength: number
	objectKey: string
	createdAt: number
	cacheHit: boolean
}>

export type ShowcaseCacheStats = Readonly<{
	localHits: number
	backendHits: number
	misses: number
	loads: number
	deduplicated: number
	entries: number
}>

export type ShowcaseSnapshot = Readonly<{
	revision: number
	engines: readonly ShowcaseRendererKind[]
	renderingProviders: Readonly<Record<ShowcaseRendererKind, string>>
	storageProvider: string
	cacheProvider: string
	ratesProvider: string
	cache: ShowcaseCacheStats
	lastRateDecision?: Readonly<{
		denied: boolean
		remaining: number
		resetAt: number
		retryAfterMs?: number
	}>
	artifacts: readonly ShowcaseArtifact[]
	lastOutbound?: Readonly<{
		ok: boolean
		status?: number
		at: number
		message: string
	}>
}>

export type ShowcaseObserver = (revision: number) => void | Promise<void>

export interface ReportStudioApi extends RpcTarget {
	snapshotDto(): ShowcaseSnapshot
	watch(observer: ShowcaseObserver): RpcTarget
	generateDto(request: ShowcaseRenderRequest): Promise<ShowcaseArtifact>
	probeOutboundDto(): Promise<NonNullable<ShowcaseSnapshot['lastOutbound']>>
	clearCacheDto(): Promise<ShowcaseCacheStats>
}
