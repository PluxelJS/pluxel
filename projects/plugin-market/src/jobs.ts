import { provenanceUnavailable } from './npm'
import { claim, cleanReceipts, failAttempt, pendingNotifications, type Database } from './store'

export async function processNotifications(db: Database) {
	const candidates = await pendingNotifications(db, Date.now())
	let processed = 0
	for (const candidate of candidates) {
		const task = await claim(db, candidate.id, Date.now())
		if (!task) continue
		// Native verification has a confirmed workerd compatibility failure. Do not
		// spend npm fetch/retry budgets or downgrade a proof-required notification.
		await failAttempt(db, task, provenanceUnavailable(), Date.now())
		processed++
	}
	await cleanReceipts(db, Date.now())
	return { processed }
}
