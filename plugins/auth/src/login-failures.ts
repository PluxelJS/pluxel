const MAX_IDENTITIES = 1_024
const MAX_FAILURES = 5
const WINDOW_MS = 5 * 60_000

type FailureState = Readonly<{
	failures: number
	expiresAt: number
}>

/** Generation-local, fixed-policy admission for expensive local credential checks. */
export class LoginFailureLimiter {
	private readonly identities = new Map<string, FailureState>()

	allows(identity: string, now: number = Date.now()): boolean {
		this.prune(now)
		const state = this.identities.get(identity)
		if (!state) return true
		this.touch(identity, state)
		return state.failures < MAX_FAILURES
	}

	recordFailure(identity: string, now: number = Date.now()): void {
		this.prune(now)
		const current = this.identities.get(identity)
		const state = Object.freeze({
			failures: Math.min(MAX_FAILURES, (current?.failures ?? 0) + 1),
			expiresAt: current?.expiresAt ?? now + WINDOW_MS,
		})
		this.touch(identity, state)
		while (this.identities.size > MAX_IDENTITIES) {
			const oldest = this.identities.keys().next().value as string | undefined
			if (oldest === undefined) break
			this.identities.delete(oldest)
		}
	}

	clear(identity?: string): void {
		if (identity === undefined) this.identities.clear()
		else this.identities.delete(identity)
	}

	get size(): number {
		return this.identities.size
	}

	private touch(identity: string, state: FailureState): void {
		this.identities.delete(identity)
		this.identities.set(identity, state)
	}

	private prune(now: number): void {
		for (const [identity, state] of this.identities) {
			if (state.expiresAt <= now) this.identities.delete(identity)
		}
	}
}
