export class VaultError extends Error {
	public readonly code:
		| 'READ_ONLY'
		| 'REVISION_CONFLICT'
		| 'ACCESS_DENIED'
		| 'DECRYPT_FAILED'
		| 'INVALID_CONFIG'
		| 'INVALID_FORMAT'
		| 'IO'
		| 'MISSING_MOUNT'
		| 'MISSING_IDENTITY'

	constructor(code: VaultError['code'], message: string, options?: { cause?: unknown }) {
		super(message)
		this.name = 'VaultError'
		this.code = code
		if (options?.cause !== undefined) (this as unknown as { cause?: unknown }).cause = options.cause
	}
}
