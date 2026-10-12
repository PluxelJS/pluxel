export function rpcError(code: string, message: string, cause?: unknown) {
	return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code })
}

export const RPC_MESSAGE_BYTES = 32 * 1024 * 1024
export const RPC_SESSION_OPTIONS = { limits: { maxMessageSize: RPC_MESSAGE_BYTES } }
