import type { RpcTarget } from 'capnweb'

export type ShowcaseRendererKind = 'echarts' | 'takumi' | 'canvas'

export type ShowcaseArtifact = Readonly<{
	id: string
	title: string
	engine: ShowcaseRendererKind
	mediaType: 'image/png'
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
	rendererProvider: string
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
	generateDto(title: string): Promise<ShowcaseArtifact>
	probeOutboundDto(): Promise<NonNullable<ShowcaseSnapshot['lastOutbound']>>
	clearCacheDto(): Promise<ShowcaseCacheStats>
}
