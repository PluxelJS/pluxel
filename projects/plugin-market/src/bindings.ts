/** Bindings supplied by the Cloudflare HTTP and scheduled entry points. */
export interface MarketBindings {
	readonly DB: D1Database
	readonly ADMIN_TOKEN?: string
	readonly REGISTRIES?: string
	readonly HOSTED_ARCHIVES?: R2Bucket
	readonly HOSTED_REGISTRY_URL?: string
	readonly HOSTED_PUBLISHERS?: string
	readonly HOSTED_READ_TOKEN?: string
	readonly MARKET_REVIEW?: string
}

export type MarketResources = Pick<
	MarketBindings,
	'DB' | 'HOSTED_ARCHIVES' | 'ADMIN_TOKEN' | 'HOSTED_READ_TOKEN'
>
