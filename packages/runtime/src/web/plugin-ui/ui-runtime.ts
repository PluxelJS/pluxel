import type {
	HmrHttpApi as CoreHmrHttpApi,
	HmrWebClient as CoreHmrWebClient,
	HmrWebClientOptions as CoreHmrWebClientOptions,
} from '../client'
import type {
	HmrUiRpcMap as CoreHmrUiRpcMap,
	HmrUiSignalDbMap as CoreHmrUiSignalDbMap,
	HmrUiSseMap as CoreHmrUiSseMap,
} from '../protocol'
import type {
	BuiltinSseEvents,
	SseClientOptions as CoreSseClientOptions,
	SseClientWithNamespaces as CoreSseClientWithNamespaces,
} from '../sse'

export interface HmrUiRpcMap extends CoreHmrUiRpcMap {}
export interface HmrUiSseMap extends CoreHmrUiSseMap {}
export interface HmrUiSignalDbMap extends CoreHmrUiSignalDbMap {}

export type ResolvedSseEvents = BuiltinSseEvents & HmrUiSseMap

type PayloadForNs<Ns extends string> = Ns extends keyof ResolvedSseEvents
	? ResolvedSseEvents[Ns]
	: unknown

export type SseNamespaceClient<Ns extends string> = {
	on(handler: (msg: SseMessage<Ns>) => void, events?: string | string[]): () => void
	onAny(handler: (msg: SseMessage<Ns>) => void): () => void
}

export type SseMessage<Ns extends string = keyof ResolvedSseEvents> = {
	namespace: Ns
	event: string
	payload: PayloadForNs<Ns>
	raw: MessageEvent
}

export type SseClientOptions = CoreSseClientOptions

export type SseClientWithNamespaces = Omit<
	CoreSseClientWithNamespaces,
	keyof ResolvedSseEvents | 'ns'
> & {
	ns<Ns extends string>(name: Ns): SseNamespaceClient<Ns>
} & {
	[K in keyof ResolvedSseEvents]: SseNamespaceClient<K & string>
}

export type HmrHttpApi = CoreHmrHttpApi
export type HmrWebClientOptions = CoreHmrWebClientOptions

export type HmrWebClient = Omit<CoreHmrWebClient, 'ui' | 'createSse' | 'sse'> & {
	ui: HmrUiRpcMap
	createSse: (options?: SseClientOptions) => SseClientWithNamespaces
	sse: SseClientWithNamespaces
}
