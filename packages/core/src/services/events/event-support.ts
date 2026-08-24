import type { Context } from '../../context/Context'
import type { EventEmitterOptions, IEventMap } from 'eventure'

export function deferEventCleanup(owner: Context, cleanup: () => void): void {
	try {
		owner.effects.defer(cleanup)
	} catch (error) {
		try {
			cleanup()
		} catch {
			// Preserve the ownership failure; cleanup is best-effort registration rollback.
		}
		throw error
	}
}

export function withEventLogger<T extends IEventMap<T>>(
	ctx: Context,
	config?: EventEmitterOptions<T>,
): EventEmitterOptions<T> {
	return {
		...config,
		logger: ctx.logger.with({ service: 'eventure' }) as unknown as EventEmitterOptions<T>['logger'],
	}
}
