export type CommercialServiceErrorCode =
	| 'COMMERCIAL_INVALID_INPUT'
	| 'COMMERCIAL_NOT_FOUND'

export class CommercialServiceError extends Error {
	readonly code: CommercialServiceErrorCode
	readonly status: number
	readonly details: Record<string, unknown>

	constructor(
		code: CommercialServiceErrorCode,
		message: string,
		options?: {
			status?: number
			details?: Record<string, unknown>
			cause?: unknown
		},
	) {
		super(message, { cause: options?.cause })
		this.name = 'CommercialServiceError'
		this.code = code
		this.status = options?.status ?? (code === 'COMMERCIAL_NOT_FOUND' ? 404 : 400)
		this.details = options?.details ?? {}
	}
}

export function isCommercialServiceError(error: unknown): error is CommercialServiceError {
	return error instanceof CommercialServiceError
}

export class CommercialDataStartupError extends Error {
	constructor(message: string, cause?: unknown) {
		super(message, { cause })
		this.name = 'CommercialDataStartupError'
	}
}
