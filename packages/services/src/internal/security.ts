import type { Context as PluxelContext } from '@pluxel/core'

export type SecurityEvent = {
	id: string
	at: number
	area: 'adminAccess' | 'vault'
	action: 'authorize' | 'verify' | 'clear' | 'preflight' | 'unlock' | 'rekey'
	status: 'success' | 'failure' | 'info'
	mount?: string
	reason?: string
	message: string
}

type AuditState = {
	seq: number
	events: SecurityEvent[]
}

const AUDIT_STATE_BY_ROOT = new WeakMap<PluxelContext['root'], AuditState>()
const MAX_EVENTS = 200

function resolveState(ctx: PluxelContext): AuditState {
	const root = ctx.root
	let state = AUDIT_STATE_BY_ROOT.get(root)
	if (state) return state
	state = {
		seq: 0,
		events: [],
	}
	AUDIT_STATE_BY_ROOT.set(root, state)
	return state
}

export function recordSecurityEvent(
	ctx: PluxelContext,
	event: Omit<SecurityEvent, 'id' | 'at'> & { at?: number },
): SecurityEvent {
	const state = resolveState(ctx)
	const next: SecurityEvent = {
		id: `security:${state.seq + 1}`,
		at: event.at ?? Date.now(),
		...event,
	}
	state.seq += 1
	state.events.unshift(next)
	if (state.events.length > MAX_EVENTS) state.events.length = MAX_EVENTS
	return next
}

export function listSecurityEvents(ctx: PluxelContext, limit = 50): SecurityEvent[] {
	const state = resolveState(ctx)
	return state.events.slice(0, Math.max(0, limit))
}
