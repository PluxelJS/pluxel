import type { EventArgs, EventDescriptor, EventListener } from '../types'

export type GuardResult = boolean | undefined | void
export type GuardPredicate<D extends EventDescriptor> = (
	...args: EventArgs<D>
) => GuardResult

export type WrapFn = <T extends (...args: any[]) => any>(listener: T) => T

export function normalizeTimes(times: number): number {
	if (!Number.isInteger(times) || times < 1) {
		throw new RangeError('times must be a positive integer')
	}
	return times
}

export function combineGuardPredicate<D extends EventDescriptor>(
	left: GuardPredicate<D> | undefined,
	right: GuardPredicate<D>,
): GuardPredicate<D> {
	return (...args) => {
		if (left !== undefined) {
			const matched = left(...args)
			if (matched === false || matched === undefined) return false
		}
		return right(...args)
	}
}

export function createLimitedListener<D extends EventDescriptor>(
	wrapped: EventListener<D>,
	times: number,
	predicate: GuardPredicate<D> | undefined,
	unsubscribe: () => void,
): EventListener<D> {
	let left = times
	const unlimited = times === 0
	if (!unlimited && times !== 1) normalizeTimes(times)

	if (predicate === undefined) {
		return ((...args: EventArgs<D>) => {
			try {
				return wrapped(...args)
			} finally {
				if (!unlimited && --left === 0) unsubscribe()
			}
		}) as EventListener<D>
	}

	return ((...args: EventArgs<D>) => {
		const matched = predicate(...args)
		if (matched === false || matched === undefined) {
			return undefined as ReturnType<EventListener<D>>
		}
		try {
			return wrapped(...args)
		} finally {
			if (!unlimited && --left === 0) unsubscribe()
		}
	}) as EventListener<D>
}
