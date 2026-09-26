import type { Pool } from 'pg'

/** Keep pg-pool idle-client failures operational instead of process-fatal. */
export function attachPostgresPoolErrorHandler(
	pool: Pick<Pool, 'on'>,
	report: (error: Error) => void,
): void {
	pool.on('error', (error) => {
		try {
			report(error)
		} catch {
			// EventEmitter treats a thrown `error` listener as process-fatal too. Reporting must be a
			// terminal boundary because pg-pool has already removed the failed idle client.
		}
	})
}
