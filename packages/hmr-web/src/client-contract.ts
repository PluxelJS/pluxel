import type { LogFilter, LogRangeResult, LogStreamMeta } from './logs'
import type { ExtensionManifest } from './plugin-ui'

export interface HmrAuthMeta {
	enabled: boolean
	pluginName: string | null
	redirectPath: string | null
	authenticated: boolean
}

export interface HmrInternalMeta {
	service: 'pluxel-hmr'
	ready: true
	auth: HmrAuthMeta
	sse: {
		namespaces: string[]
	}
	extensions: {
		version: number
		modules: number
	}
	transport: {
		rpc: string
		graphql: string
		sse: string
		mcp: string
	}
}

export interface HmrStreamIndex {
	streams: LogStreamMeta[]
}

export type HmrLogRangeQuery = LogFilter & {
	epoch?: number
	from?: string
	limit?: number
}

export type EdenResultLike<T = unknown> = {
	data: T | null
	error: unknown
	response?: Response
}

type HmrTreatyFetchOptions = {
	fetch?: RequestInit
}

type HmrTreatyQueryOptions<TQuery> = HmrTreatyFetchOptions & {
	query?: TQuery
}

type HmrTreatyGet<TData, TQuery = never> = {
	get(options?: [TQuery] extends [never] ? HmrTreatyFetchOptions : HmrTreatyQueryOptions<TQuery>): Promise<
		EdenResultLike<TData>
	>
}

type HmrTreatyStreamRoute = {
	meta: HmrTreatyGet<LogStreamMeta>
	range: HmrTreatyGet<LogRangeResult, HmrLogRangeQuery>
}

type HmrTreatyStreamsRoute = HmrTreatyGet<HmrStreamIndex> & ((params: {
	streamId: string
}) => HmrTreatyStreamRoute)

export interface HmrTreatyClient {
	meta: HmrTreatyGet<HmrInternalMeta> & {
		auth: HmrTreatyGet<HmrAuthMeta>
	}
	extensions: {
		manifest: HmrTreatyGet<ExtensionManifest>
	}
	logs: {
		v1: {
			streams: HmrTreatyStreamsRoute
		}
	}
}
