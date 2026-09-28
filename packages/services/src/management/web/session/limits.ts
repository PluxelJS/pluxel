/** Physical UTF-8 ceiling enforced in both directions by the Runtime control WebSocket. */
export const RUNTIME_SESSION_MAX_MESSAGE_BYTES = 256 * 1024

/**
 * Budget for one application DTO before Cap'n Web adds its result envelope.
 *
 * The estimate uses JSON UTF-8 bytes while Cap'n Web owns the final wire encoding, so only half of
 * the physical frame is assigned to the DTO. Keeping both values here makes that safety margin an
 * explicit carrier invariant rather than an unrelated logging magic number.
 */
export const RUNTIME_SESSION_RPC_PAYLOAD_BUDGET_BYTES = RUNTIME_SESSION_MAX_MESSAGE_BYTES / 2
