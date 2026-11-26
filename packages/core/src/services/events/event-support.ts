import type { Context } from '../../context/Context'
import {
	observeSubscriptionEnd,
	type EventureOptions,
	type IEventMap,
	type Unsubscribe,
} from 'eventure'

export function deferEventCleanup(owner: Context, cleanup: Unsubscribe): void {
	try {
		const registration = owner.effects.defer(cleanup)
		observeSubscriptionEnd(cleanup, () => registration.cancel())
	} catch (error) {
		try {
			cleanup()
		} catch {
			// Preserve the ownership failure; cleanup is best-effort registration rollback.
		}
		throw error
	}
}

export function ownEventWaiter<T extends Promise<unknown> & { cancel(): void }>(
	owner: Context,
	pending: T,
): T {
	try {
		deferEventCleanup(owner, pending.cancel)
	} catch (error) {
		// The caller receives the ownership failure and never receives the cancelled waiter.
		void pending.catch(() => {})
		throw error
	}
	return pending
}

export function withEventLogger<T extends IEventMap<T>>(
	ctx: Context,
	config?: EventureOptions<T>,
): EventureOptions<T> {
	return {
		...config,
		logger: ctx.logger.with({ service: 'eventure' }) as unknown as EventureOptions<T>['logger'],
	}
}
