import type { RateDecision, ResolvedRatePolicy } from './types.ts'

type StateBase = {
	readonly policy: Readonly<ResolvedRatePolicy>
	observedAt: number
	expiresAt: number
}

export type TokenBucketState = StateBase & {
	readonly policy: Readonly<Extract<ResolvedRatePolicy, { algorithm: 'token-bucket' }>>
	balanceUnits: number
}

export type FixedWindowState = StateBase & {
	readonly policy: Readonly<Extract<ResolvedRatePolicy, { algorithm: 'fixed-window' }>>
	windowStart: number
	used: number
}

export type SlidingCounterState = StateBase & {
	readonly policy: Readonly<Extract<ResolvedRatePolicy, { algorithm: 'sliding-window-counter' }>>
	windowStart: number
	previous: number
	current: number
}

export type SlidingLogState = StateBase & {
	readonly policy: Readonly<Extract<ResolvedRatePolicy, { algorithm: 'sliding-window-log' }>>
	events: Array<{ at: number; cost: number }>
	head: number
	used: number
}

export type RateState = TokenBucketState | FixedWindowState | SlidingCounterState | SlidingLogState

export function createState(policy: Readonly<ResolvedRatePolicy>, now: number): RateState {
	switch (policy.algorithm) {
		case 'token-bucket':
			return {
				policy,
				observedAt: now,
				expiresAt: now + 1,
				balanceUnits: policy.burst * policy.windowMs,
			}
		case 'fixed-window':
			return {
				policy,
				observedAt: now,
				expiresAt: now + 1,
				windowStart: alignedWindow(now, policy.windowMs),
				used: 0,
			}
		case 'sliding-window-counter':
			return {
				policy,
				observedAt: now,
				expiresAt: now + 1,
				windowStart: alignedWindow(now, policy.windowMs),
				previous: 0,
				current: 0,
			}
		case 'sliding-window-log':
			return { policy, observedAt: now, expiresAt: now + 1, events: [], head: 0, used: 0 }
	}
}

export function consumeState(state: RateState, cost: number, sourceNow: number): RateDecision {
	const now = Math.max(sourceNow, state.observedAt)
	let decision: RateDecision
	switch (state.policy.algorithm) {
		case 'token-bucket':
			decision = consumeTokenBucket(state as TokenBucketState, cost, now)
			break
		case 'fixed-window':
			decision = consumeFixedWindow(state as FixedWindowState, cost, now)
			break
		case 'sliding-window-counter':
			decision = consumeSlidingCounter(state as SlidingCounterState, cost, now)
			break
		case 'sliding-window-log':
			decision = consumeSlidingLog(state as SlidingLogState, cost, now)
			break
	}
	state.observedAt = now
	return decision
}

function consumeTokenBucket(state: TokenBucketState, cost: number, now: number): RateDecision {
	const { limit, windowMs, burst } = state.policy
	const capacityUnits = burst * windowMs
	const refillElapsed = now - state.observedAt
	const missingUnits = capacityUnits - state.balanceUnits
	if (missingUnits > 0) {
		if (refillElapsed >= ceilDivide(missingUnits, limit)) state.balanceUnits = capacityUnits
		else state.balanceUnits += refillElapsed * limit
	}
	const costUnits = cost * windowMs
	const denied = state.balanceUnits < costUnits
	if (!denied) state.balanceUnits -= costUnits
	const untilFull = ceilDivide(capacityUnits - state.balanceUnits, limit)
	state.expiresAt = now + Math.max(1, untilFull)
	const remaining = Math.floor(state.balanceUnits / windowMs)
	if (!denied) return { denied: false, remaining, resetAt: now + untilFull }
	return {
		denied: true,
		remaining,
		retryAfterMs: Math.max(1, ceilDivide(costUnits - state.balanceUnits, limit)),
		resetAt: now + untilFull,
	}
}

function consumeFixedWindow(state: FixedWindowState, cost: number, now: number): RateDecision {
	const { limit, windowMs } = state.policy
	const start = alignedWindow(now, windowMs)
	if (start !== state.windowStart) {
		state.windowStart = start
		state.used = 0
	}
	const denied = cost > limit - state.used
	if (!denied) state.used += cost
	const resetAt = state.windowStart + windowMs
	state.expiresAt = resetAt
	const remaining = limit - state.used
	return denied
		? { denied: true, remaining, retryAfterMs: Math.max(1, resetAt - now), resetAt }
		: { denied: false, remaining, resetAt }
}

function consumeSlidingCounter(
	state: SlidingCounterState,
	cost: number,
	now: number,
): RateDecision {
	const { limit, windowMs } = state.policy
	const targetStart = alignedWindow(now, windowMs)
	const windows = Math.floor((targetStart - state.windowStart) / windowMs)
	if (windows === 1) {
		state.previous = state.current
		state.current = 0
		state.windowStart = targetStart
	} else if (windows >= 2) {
		state.previous = 0
		state.current = 0
		state.windowStart = targetStart
	}
	const elapsed = now - state.windowStart
	const usedUnits = state.current * windowMs + state.previous * (windowMs - elapsed)
	const capacityUnits = limit * windowMs
	const costUnits = cost * windowMs
	const denied = costUnits > capacityUnits - usedUnits
	if (!denied) state.current += cost
	const decidedUnits = denied ? usedUnits : usedUnits + costUnits
	const remaining = Math.floor((capacityUnits - decidedUnits) / windowMs)
	const resetAt =
		state.current > 0
			? state.windowStart + 2 * windowMs
			: state.previous > 0
				? state.windowStart + windowMs
				: now
	state.expiresAt = Math.max(now + 1, resetAt)
	if (!denied) return { denied: false, remaining, resetAt }
	return {
		denied: true,
		remaining,
		retryAfterMs: slidingCounterRetry(state, costUnits, capacityUnits, now),
		resetAt,
	}
}

function slidingCounterRetry(
	state: SlidingCounterState,
	costUnits: number,
	capacityUnits: number,
	now: number,
): number {
	const { windowMs } = state.policy
	const boundary = state.windowStart + windowMs
	const elapsed = now - state.windowStart
	const usedNow = state.current * windowMs + state.previous * (windowMs - elapsed)
	const deficitNow = costUnits - (capacityUnits - usedNow)
	if (state.previous > 0) {
		const wait = Math.max(1, ceilDivide(deficitNow, state.previous))
		if (now + wait <= boundary) return wait
	}
	const atBoundary = state.current * windowMs
	if (costUnits <= capacityUnits - atBoundary) return Math.max(1, boundary - now)
	const afterBoundary = ceilDivide(costUnits - (capacityUnits - atBoundary), state.current)
	return Math.max(1, boundary - now + afterBoundary)
}

function consumeSlidingLog(state: SlidingLogState, cost: number, now: number): RateDecision {
	const { limit, windowMs } = state.policy
	const cutoff = now - windowMs
	while (state.head < state.events.length && state.events[state.head]!.at <= cutoff) {
		state.used -= state.events[state.head]!.cost
		state.head++
	}
	if (state.head > 64 && state.head * 2 >= state.events.length) {
		state.events = state.events.slice(state.head)
		state.head = 0
	}
	const denied = cost > limit - state.used
	if (!denied) {
		state.events.push({ at: now, cost })
		state.used += cost
	}
	const remaining = limit - state.used
	const last = state.events.at(-1)
	const resetAt = last ? last.at + windowMs : now
	state.expiresAt = Math.max(now + 1, resetAt)
	if (!denied) return { denied: false, remaining, resetAt }

	let released = 0
	const deficit = cost - (limit - state.used)
	let retryAt = now + 1
	for (let index = state.head; index < state.events.length; index++) {
		const event = state.events[index]!
		released += event.cost
		if (released >= deficit) {
			retryAt = event.at + windowMs
			break
		}
	}
	return { denied: true, remaining, retryAfterMs: Math.max(1, retryAt - now), resetAt }
}

function alignedWindow(now: number, windowMs: number): number {
	return Math.floor(now / windowMs) * windowMs
}

function ceilDivide(dividend: number, divisor: number): number {
	return Math.ceil(dividend / divisor)
}
