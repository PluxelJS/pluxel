import type { RpcTarget } from '@pluxel/runtime/capnweb'

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
	draftStorageProvider: string
	releaseStorageProvider: string
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
	snapshot(): ShowcaseSnapshot
	watch(observer: ShowcaseObserver): RpcTarget
	generate(title: string): Promise<ShowcaseArtifact>
	probeOutbound(): Promise<ShowcaseSnapshot['lastOutbound']>
	clearCache(): Promise<ShowcaseCacheStats>
}
