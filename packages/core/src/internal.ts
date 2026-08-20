export {
	closeOwnerInvocations,
	enterOwnerInvocation,
	type OwnerInvocationLease,
} from './internal/owner-invocations'

/** @internal Optional service hook for immutable owner-bound Context capability views. */
export const OWNER_CONTEXT_BIND = Symbol.for('pluxel:ctx.owner-context-bind')
