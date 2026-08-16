// HMR 注意：必须使用 Symbol.for
export const PLUGIN_CTX = Symbol.for('pluxel:plugin:ctx')
export const FORK_CTX = Symbol.for('pluxel:plugin:ctx:fork')
/** @internal Capability fields may expose a caller-bound facade through this hook. */
export const CALLER_CONTEXT_BIND = Symbol.for('pluxel:plugin:caller-context-bind')
/** @internal Marks an init rejection caused by a cleanup returned after drain began. */
export const LATE_INIT_CLEANUP_ERROR = Symbol.for('pluxel:plugin:late-init-cleanup-error')
