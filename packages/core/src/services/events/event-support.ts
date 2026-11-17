import { EffectsService } from '../effects/EffectsService'
import { LoggerService } from '../../logger/LoggerService'
import type { Context } from '../../context/Context'
import type { EventureOptions, IEventMap } from 'eventure'

export function deferEventCleanup(owner: Context, cleanup: () => void): void {
	try {
		owner.service(EffectsService).defer(cleanup)
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
	config?: EventureOptions<T>,
): EventureOptions<T> {
	return {
		...config,
		logger: ctx
			.service(LoggerService)
			.with({ service: 'eventure' }) as unknown as EventureOptions<T>['logger'],
	}
}
