import { RpcTarget } from 'capnweb'
import { and, desc, eq, isNull, lt, or } from 'drizzle-orm'
import { processNotifications } from './jobs'
import { fetchObservation, fetchRelease } from './npm'
import {
	coordinate,
	MarketError,
	object,
	packageIdentity,
	taxonomySlug,
	type Coordinate,
	type PackageIdentity,
	type MarketMetadata,
	type NotificationQuery,
} from './protocol'
import { audits, notifications, packages } from './schema'
import {
	commitRelease,
	commitObservation,
	connect,
	listNotifications,
	notificationDetail,
	retryNotification,
	setMetadata,
	setVisibility,
} from './store'
import { sourceFor, type RegistrySource } from './sources'
import { repositoryStars } from './repository'

export class MarketAdmin extends RpcTarget {
	#db: ReturnType<typeof connect>
	#sources: readonly RegistrySource[]

	constructor(binding: D1Database, sources: readonly RegistrySource[]) {
		super()
		this.#db = connect(binding)
		this.#sources = sources
	}

	async getPackage(input: PackageIdentity) {
		const selected = packageIdentity(input)
		sourceFor(this.#sources, selected.registry)
		return (
			(await this.#db
				.select()
				.from(packages)
				.where(and(eq(packages.registry, selected.registry), eq(packages.name, selected.name)))
				.get()) ?? null
		)
	}

	/** Fetch and validate an exact npm release; a successful call has committed it. */
	async refresh(input: Coordinate) {
		try {
			const selected = coordinate(input)
			const { release, observation } = await fetchRelease(
				selected,
				sourceFor(this.#sources, selected.registry),
			)
			return {
				status: 'indexed' as const,
				release: await commitRelease(this.#db, release, observation),
			}
		} catch (error) {
			if (!(error instanceof MarketError)) throw error
			return {
				status: 'failed' as const,
				code: error.code,
				message: error.message,
				retryable: error.retryable,
			}
		}
	}

	/** Registry metadata stays browsable even when a package cannot be installed by this Host. */
	async observe(input: PackageIdentity) {
		try {
			const selected = packageIdentity(input)
			const observation = await fetchObservation(
				selected,
				sourceFor(this.#sources, selected.registry),
			)
			return {
				status: 'observed' as const,
				record: await commitObservation(this.#db, selected, observation),
			}
		} catch (error) {
			if (!(error instanceof MarketError)) throw error
			return {
				status: 'failed' as const,
				code: error.code,
				message: error.message,
				retryable: error.retryable,
			}
		}
	}

	async setVisibility(input: PackageIdentity & { expectedRevision: number; hidden: boolean }) {
		if (
			!object(input) ||
			typeof input.registry !== 'string' ||
			!Number.isSafeInteger(input.expectedRevision) ||
			input.expectedRevision < 1 ||
			typeof input.hidden !== 'boolean' ||
			Object.keys(input).length !== 4
		) {
			return { status: 'invalid' as const }
		}
		const selected = packageIdentity({ registry: input.registry, name: input.name })
		sourceFor(this.#sources, selected.registry)
		return setVisibility(this.#db, { ...input, ...selected }, Date.now())
	}

	/** Market-owned curation shares the visibility revision; npm observations cannot overwrite it. */
	async setMetadata(input: PackageIdentity & MarketMetadata & { expectedRevision: number }) {
		if (
			!object(input) ||
			Object.keys(input).length !== 6 ||
			!Number.isSafeInteger(input.expectedRevision) ||
			input.expectedRevision < 1 ||
			typeof input.official !== 'boolean' ||
			(input.category !== null && !taxonomySlug(input.category)) ||
			!Array.isArray(input.tags) ||
			input.tags.length > 20 ||
			input.tags.some((tag) => !taxonomySlug(tag)) ||
			new Set(input.tags).size !== input.tags.length
		)
			return { status: 'invalid' as const }
		const selected = packageIdentity({ registry: input.registry, name: input.name })
		sourceFor(this.#sources, selected.registry)
		return setMetadata(
			this.#db,
			{ ...input, ...selected, tags: [...input.tags].sort() },
			Date.now(),
		)
	}

	/** Explicitly observe an author's repository; read paths never call GitHub. */
	async refreshRepository(input: PackageIdentity) {
		const selected = packageIdentity(input)
		sourceFor(this.#sources, selected.registry)
		const identity = and(eq(packages.registry, selected.registry), eq(packages.name, selected.name))
		const current = await this.#db.select().from(packages).where(identity).get()
		if (!current) return { status: 'not-found' as const }
		if (!current.repository) return { status: 'unavailable' as const, code: 'missing-repository' }
		try {
			const observed = await repositoryStars(current.repository)
			const changed = await this.#db
				.update(packages)
				.set({ repositoryStars: observed.stars, repositoryObservedAt: observed.observedAt })
				.where(
					and(
						identity,
						eq(packages.repository, current.repository),
						or(
							isNull(packages.repositoryObservedAt),
							lt(packages.repositoryObservedAt, observed.observedAt),
						),
					),
				)
				.returning({
					repository: packages.repository,
					stars: packages.repositoryStars,
					observedAt: packages.repositoryObservedAt,
				})
			return changed[0]
				? { status: 'updated' as const, ...changed[0] }
				: { status: 'conflict' as const }
		} catch (error) {
			if (!(error instanceof MarketError)) throw error
			return {
				status: 'failed' as const,
				code: error.code,
				message: error.message,
				retryable: error.retryable,
			}
		}
	}

	async getNotification(id: string) {
		if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id))
			throw new TypeError('Invalid receipt id')
		const row = await this.#db.select().from(notifications).where(eq(notifications.id, id)).get()
		return row ? notificationDetail(row) : null
	}

	async listNotifications(input: NotificationQuery = {}) {
		return listNotifications(this.#db, input)
	}

	async retryNotification(id: string) {
		if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id))
			throw new TypeError('Invalid receipt id')
		return retryNotification(this.#db, id, Date.now())
	}

	/** Process one bounded scheduled batch, useful for local development and recovery. */
	async processNotifications() {
		return processNotifications(this.#db)
	}

	async recentChanges(input: PackageIdentity) {
		const selected = packageIdentity(input)
		return this.#db
			.select()
			.from(audits)
			.where(and(eq(audits.registry, selected.registry), eq(audits.name, selected.name)))
			.orderBy(desc(audits.at), desc(audits.id))
			.limit(20)
	}
}
