import { RpcTarget } from 'capnweb'
import { and, desc, eq } from 'drizzle-orm'
import { observeRepository } from './catalog/repository'
import {
	commitObservation,
	commitRepositoryObservation,
	setMetadata,
	setVisibility,
} from './catalog/write'
import type { Database } from './db/d1'
import { audits, packages } from './db/schema'
import { commitRelease } from './indexing/commit'
import { processNotifications } from './indexing/jobs'
import {
	findNotification,
	listNotifications,
	notificationDetail,
	retryNotification,
} from './indexing/notifications'
import {
	coordinate,
	MarketError,
	marketAuthorId,
	object,
	packageIdentity,
	taxonomySlug,
	type Coordinate,
	type PackageIdentity,
	type MarketCuration,
	type NotificationQuery,
} from './protocol'
import { fetchObservation, fetchRelease } from './registry/npm'
import type { PackageReview } from './registry/review'
import { sourceFor, type RegistrySource } from './registry/sources'

function validAuthor(value: unknown) {
	return (
		object(value) &&
		Object.keys(value).length === 2 &&
		marketAuthorId(value.id) &&
		typeof value.name === 'string' &&
		value.name.length > 0 &&
		value.name.length <= 120 &&
		value.name === value.name.trim() &&
		!/\p{Cc}/u.test(value.name)
	)
}

export class MarketAdmin extends RpcTarget {
	#db: Database
	#sources: readonly RegistrySource[]
	#review: PackageReview
	#signal: AbortSignal

	constructor({
		db,
		sources,
		review,
		signal,
	}: {
		db: Database
		sources: readonly RegistrySource[]
		review: PackageReview
		signal: AbortSignal
	}) {
		super()
		this.#db = db
		this.#sources = sources
		this.#review = review
		this.#signal = signal
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
				{ review: this.#review, signal: this.#signal },
			)
			this.#signal.throwIfAborted()
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
				this.#signal,
			)
			this.#signal.throwIfAborted()
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
	async setMetadata(input: PackageIdentity & MarketCuration & { expectedRevision: number }) {
		if (
			!object(input) ||
			Object.keys(input).some(
				(key) =>
					![
						'registry',
						'name',
						'expectedRevision',
						'official',
						'category',
						'tags',
						'author',
					].includes(key),
			) ||
			!Number.isSafeInteger(input.expectedRevision) ||
			input.expectedRevision < 1 ||
			typeof input.official !== 'boolean' ||
			(input.category !== null && !taxonomySlug(input.category)) ||
			!Array.isArray(input.tags) ||
			input.tags.length > 20 ||
			input.tags.some((tag) => !taxonomySlug(tag)) ||
			new Set(input.tags).size !== input.tags.length ||
			(input.author !== undefined && input.author !== null && !validAuthor(input.author))
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
			const observed = await observeRepository(current.repository, this.#signal)
			this.#signal.throwIfAborted()
			const changed = await commitRepositoryObservation(
				this.#db,
				selected,
				current.repository,
				observed,
			)
			return changed ? { status: 'updated' as const, ...changed } : { status: 'conflict' as const }
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
		const row = await findNotification(this.#db, id)
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
		return processNotifications(this.#db, this.#sources, {
			review: this.#review,
			signal: this.#signal,
		})
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
