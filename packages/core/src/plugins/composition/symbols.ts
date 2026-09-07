/** @internal Capability fields may expose a caller-bound facade through this hook. */
export const CALLER_CONTEXT_BIND = Symbol('pluxel:plugin:caller-context-bind')
/** @internal Marks an init rejection caused by a cleanup returned after drain began. */
export const LATE_INIT_CLEANUP_ERROR = Symbol('pluxel:plugin:late-init-cleanup-error')
