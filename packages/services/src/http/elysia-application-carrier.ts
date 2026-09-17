/** @internal Immutable inputs transferred from one owner Elysia upgrade to the host carrier. */
export type ElysiaWebSocketUpgrade = Readonly<{
	/** The original carrier request. Hooks must be attached to this request, not a derived clone. */
	request: Request
	/** The request Elysia passed to `server.upgrade()`. */
	upgradeRequest: Request
	ownerKey: string
	headers?: HeadersInit
	data: unknown
	/** Aborts when the client ingress or owning Plugin generation is stopped. */
	signal: AbortSignal
	/** Exactly-once release for the Core owner invocation admission. */
	release(): void
}>

export type ElysiaCarrierRequestAddress = Readonly<{
	address: string
	port: number
	family: 'IPv4' | 'IPv6'
}>

export type ElysiaCarrierMetadata = Readonly<{
	url: URL
	port: number
	hostname: string
	development: boolean
}>

/**
 * @internal Platform carrier installed by a launcher after the Runtime root is created.
 *
 * Runtime owns route selection and generation admission. The carrier owns the physical upgrade,
 * socket callbacks, topic transport and connection close. A successful `upgrade()` transfers the
 * supplied lease until the carrier calls `release()`.
 */
export interface ElysiaApplicationCarrier {
	readonly metadata: ElysiaCarrierMetadata
	upgrade(input: ElysiaWebSocketUpgrade): boolean
	publish(
		ownerKey: string,
		topic: string,
		data: string | ArrayBufferView | ArrayBufferLike,
		compress?: boolean,
	): number
	pending(ownerKey: string): number
	requestIP(request: Request): ElysiaCarrierRequestAddress | null
}
