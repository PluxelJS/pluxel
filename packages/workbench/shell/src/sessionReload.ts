import type { RuntimeSessionEvent } from './runtime'
import type { UpdatePayload } from 'vite/types/hmrPayload.js'

const RELOAD_HISTORY_KEY = 'pluxel.workbench.session-reloads'
const RELOAD_WINDOW_MS = 10_000
const MAX_AUTOMATIC_RELOADS = 3
export const SESSION_RELOAD_DELAY_MS = 750

export type SessionReloadDecision = 'automatic' | 'authentication' | 'frequent' | 'unavailable'

export function installSessionEntryHmrBoundary(options: {
	// Vite awaits beforeUpdate listeners before evaluating replacements.
	hot: {
		on(event: 'vite:beforeUpdate', listener: (payload: UpdatePayload) => void | Promise<void>): void
	}
	entryUrl: string
	dispose: () => void
	reload: () => void
}): void {
	const entryPath = new URL(options.entryUrl).pathname
	options.hot.on('vite:beforeUpdate', async ({ updates }) => {
		if (
			!updates.some((update) =>
				[update.path, update.acceptedPath].some(
					(path) => new URL(path, options.entryUrl).pathname === entryPath,
				),
			)
		)
			return
		// Vite awaits this listener before importing replacements. Re-evaluating the document
		// entry would create a second physical session and React root. Ordinary component HMR
		// can proceed, but this update lane ends with full document navigation.
		options.dispose()
		options.reload()
		await new Promise<void>(() => {})
	})
}

export function sessionReloadDelay(storage: Pick<Storage, 'getItem'>, now = Date.now()): number {
	try {
		return SESSION_RELOAD_DELAY_MS * 2 ** Math.min(readRecentReloads(storage, now).length, 2)
	} catch {
		return SESSION_RELOAD_DELAY_MS
	}
}

/** Survives document replacement; a per-document counter cannot stop a reload loop. */
export function sessionReloadDecision(
	cause: RuntimeSessionEvent['cause'],
	storage: Pick<Storage, 'getItem'>,
	now = Date.now(),
): SessionReloadDecision {
	if (cause === 'authentication') return 'authentication'
	try {
		return readRecentReloads(storage, now).length < MAX_AUTOMATIC_RELOADS ? 'automatic' : 'frequent'
	} catch {
		return 'unavailable'
	}
}

/** Reserve only when navigation actually starts, never in React render or effect setup. */
export function reserveSessionReload(
	storage: Pick<Storage, 'getItem' | 'setItem'>,
	now = Date.now(),
): boolean {
	try {
		const recent = readRecentReloads(storage, now)
		if (recent.length >= MAX_AUTOMATIC_RELOADS) return false
		storage.setItem(RELOAD_HISTORY_KEY, JSON.stringify([...recent, now]))
		return true
	} catch {
		return false
	}
}

export function clearSessionReloadHistory(storage: Pick<Storage, 'removeItem'>): void {
	try {
		storage.removeItem(RELOAD_HISTORY_KEY)
	} catch {}
}

function readRecentReloads(storage: Pick<Storage, 'getItem'>, now: number): number[] {
	const raw: unknown = JSON.parse(storage.getItem(RELOAD_HISTORY_KEY) ?? '[]')
	if (!Array.isArray(raw)) return []
	return raw
		.filter(
			(time): time is number =>
				typeof time === 'number' &&
				Number.isFinite(time) &&
				time <= now &&
				now - time < RELOAD_WINDOW_MS,
		)
		.slice(-MAX_AUTOMATIC_RELOADS)
}
