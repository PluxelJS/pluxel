import type { Pool } from 'pg'

/** Keep pg-pool idle-client failures operational instead of process-fatal. */
export function attachPostgresPoolErrorHandler(
	pool: Pick<Pool, 'on' | 'off'>,
	report: (error: Error) => void,
): () => void {
	const listener = (error: Error): void => {
		try {
			report(error)
		} catch {
			// EventEmitter treats a thrown `error` listener as process-fatal too. Reporting must be a
			// terminal boundary because pg-pool has already removed the failed idle client.
		}
	}
	pool.on('error', listener)
	return () => {
		pool.off('error', listener)
	}
}
