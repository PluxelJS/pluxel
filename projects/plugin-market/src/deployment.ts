import type { ApplicationEnvironment } from '@pluxel/host/application'
import type { MarketResources } from './bindings'
import { connect } from './db/d1'
import { HostedRegistry } from './registry/hosted'
import { registrySources, type RegistrySource } from './registry/sources'
import { createPackageReview, type PackageReview } from './registry/review'

/** Parse deployment policy once. D1, R2 and request-local transports belong to each call. */
export class MarketDeployment {
	readonly review: PackageReview
	private readonly sources: readonly RegistrySource[]
	private readonly hosted?: HostedRegistry

	constructor(env: ApplicationEnvironment['env']) {
		this.review = createPackageReview(env.MARKET_REVIEW)
		this.sources = registrySources(env.REGISTRIES)
		if (env.HOSTED_REGISTRY_URL !== undefined || env.HOSTED_PUBLISHERS !== undefined)
			this.hosted = new HostedRegistry(env.HOSTED_REGISTRY_URL, env.HOSTED_PUBLISHERS, this.review)
	}

	open({ DB, HOSTED_ARCHIVES: archives, HOSTED_READ_TOKEN: readToken }: MarketResources) {
		const db = connect(DB)
		const hosted = this.hosted
		if (!hosted && !archives && readToken === undefined) return { db, sources: this.sources }
		if (!hosted || !archives)
			throw new Error(
				'Hosted registry requires HOSTED_ARCHIVES, HOSTED_REGISTRY_URL and HOSTED_PUBLISHERS',
			)
		if (readToken !== undefined && !/^[\x21-\x7e]+$/.test(readToken))
			throw new Error('HOSTED_READ_TOKEN must contain printable non-space ASCII')
		const storage = { db, archives, readToken }
		const fetchHosted = (request: Request) => hosted.fetch(request, storage)
		const sources = this.sources.map((source) =>
			source.registry === hosted.url ? { ...source, fetch: fetchHosted } : source,
		)
		return { db, fetchHosted, sources }
	}
}
