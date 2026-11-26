import type { Database } from '../db/d1'
import { MarketError } from '../protocol'
import { fetchRelease, provenanceUnavailable } from '../registry/npm'
import type { PackageReview } from '../registry/review'
import { sourceFor, type RegistrySource } from '../registry/sources'
import { commitRelease } from './commit'
import { claim, cleanReceipts, failAttempt, pendingNotifications } from './notifications'

export async function processNotifications(
	db: Database,
	sources: readonly RegistrySource[],
	{ review, signal }: { review: PackageReview; signal?: AbortSignal },
) {
	const candidates = await pendingNotifications(db, Date.now())
	let processed = 0
	for (const candidate of candidates) {
		signal?.throwIfAborted()
		const task = await claim(db, candidate.id, Date.now())
		if (!task) continue
		try {
			const source = sourceFor(sources, task.registry)
			if (source.notificationIndexing !== 'unsigned') throw provenanceUnavailable()
			const { registry, name, version } = task
			const { release, observation } = await fetchRelease({ registry, name, version }, source, {
				review,
				signal,
			})
			signal?.throwIfAborted()
			await commitRelease(db, release, observation, task)
		} catch (error) {
			// An interrupted attempt is recovered by the same durable lease as a stopped Worker.
			signal?.throwIfAborted()
			if (!(error instanceof MarketError)) throw error
			await failAttempt(db, task, error, Date.now())
		}
		processed++
	}
	signal?.throwIfAborted()
	await cleanReceipts(db, Date.now())
	return { processed }
}
