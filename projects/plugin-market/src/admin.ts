import { RpcTarget } from 'capnweb'
import { desc, eq } from 'drizzle-orm'
import { processNotifications } from './jobs'
import { fetchRelease } from './npm'
import { coordinate, MarketError, object, packageName, type Coordinate } from './protocol'
import { audits, notifications, packages } from './schema'
import { commitRelease, connect, retryNotification, setVisibility } from './store'

export class MarketAdmin extends RpcTarget {
	#db: ReturnType<typeof connect>

	constructor(binding: D1Database) {
		super()
		this.#db = connect(binding)
	}

	async getPackage(name: string) {
		if (!packageName(name)) throw new TypeError('Expected an npm package name')
		return (await this.#db.select().from(packages).where(eq(packages.name, name)).get()) ?? null
	}

	/** Fetch and validate an exact npm release; a successful call has committed it. */
	async refresh(input: Coordinate) {
		try {
			const selected = coordinate(input)
			const { release, observation } = await fetchRelease(selected)
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

	async setVisibility(input: { name: string; expectedRevision: number; hidden: boolean }) {
		if (
			!object(input) ||
			!packageName(input.name) ||
			!Number.isSafeInteger(input.expectedRevision) ||
			input.expectedRevision < 1 ||
			typeof input.hidden !== 'boolean' ||
			Object.keys(input).length !== 3
		) {
			return { status: 'invalid' as const }
		}
		return setVisibility(this.#db, input, Date.now())
	}

	async getNotification(id: string) {
		if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id))
			throw new TypeError('Invalid receipt id')
		return (
			(await this.#db.select().from(notifications).where(eq(notifications.id, id)).get()) ?? null
		)
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

	async recentChanges(name: string) {
		if (!packageName(name)) throw new TypeError('Expected an npm package name')
		return this.#db
			.select()
			.from(audits)
			.where(eq(audits.name, name))
			.orderBy(desc(audits.at), desc(audits.id))
			.limit(20)
	}
}
