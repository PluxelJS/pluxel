/** Framework service integration only; no optional backend or transport dependencies. */
export { pinOwnerContext } from './internal/owner-view'
export { recordSecurityEvent, listSecurityEvents, type SecurityEvent } from './internal/security'

export { ElysiaRuntime } from './elysia/runtime'
export type { ElysiaApplicationCarrier } from './elysia/elysia-application-carrier'
