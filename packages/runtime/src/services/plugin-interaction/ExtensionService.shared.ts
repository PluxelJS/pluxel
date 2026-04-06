import type {
	ExtensionInteractionRecord,
	InteractionOfferDef,
	InteractionSessionDef,
	InteractionSurfaceDef,
} from '../../web/extensions'
import type { InteractionContract, InteractionContractRef } from '../../web/extensions'

export type RegisteredSurface = InteractionSurfaceDef & {
	runtime: {
		contract: InteractionContract
		input?: () => unknown | Promise<unknown>
		onDraftChange?: (
			draft: unknown,
			context: InteractionSurfaceRuntimeContext,
		) => unknown | Promise<unknown>
		apply: (result: unknown, context: InteractionSurfaceApplyContext) => unknown | Promise<unknown>
	}
}

export type RegisteredOffer = InteractionOfferDef & {
	runtime: {
		contract: InteractionContract
		prepare?: (
			context: InteractionOfferPrepareContext,
		) => InteractionOfferPrepareResult | Promise<InteractionOfferPrepareResult>
	}
}

export type ResolvedSessionCandidate = {
	session: InteractionSessionDef
	record: ExtensionInteractionRecord
}

export type InteractionSurfaceRuntimeContext = {
	sessionId: string
	targetPlugin: string
	providerPlugin: string
	surfaceId: string
	offerId: string
	contract: InteractionContractRef
	input: unknown
}

export type InteractionSurfaceApplyContext = InteractionSurfaceRuntimeContext & {
	draft: unknown
}

export type InteractionOfferPrepareContext = {
	sessionId: string
	targetPlugin: string
	providerPlugin: string
	surfaceId: string
	offerId: string
	contract: InteractionContractRef
	input: unknown
	signal: AbortSignal
}

export type InteractionOfferPrepareResult = {
	draft?: unknown
	prepared?: unknown
}

export function normalizeInteractionContractRef(
	contract: InteractionContract,
): InteractionContractRef {
	const id = String(contract?.id ?? '').trim()
	if (!id) throw new Error('[ExtensionService] interaction contract id required')
	const version = Number(contract?.version ?? NaN)
	if (!Number.isInteger(version) || version <= 0) {
		throw new Error('[ExtensionService] interaction contract version must be a positive integer')
	}
	return {
		id,
		version,
		...(typeof contract.label === 'string' && contract.label.trim()
			? { label: contract.label.trim() }
			: {}),
	}
}

export function stripRuntime<T extends { runtime?: unknown }>(value: T): Omit<T, 'runtime'> {
	const { runtime: _runtime, ...rest } = value
	return rest
}

export function normalizePrepareResult(value: unknown): InteractionOfferPrepareResult {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return value === undefined ? {} : { prepared: value }
	}
	const record = value as Record<string, unknown>
	if ('draft' in record || 'prepared' in record) {
		return {
			...('draft' in record ? { draft: record.draft } : {}),
			...('prepared' in record ? { prepared: record.prepared } : {}),
		}
	}
	return { prepared: value }
}

export function assertSerializableValue(label: string, value: unknown): void {
	if (value === undefined) return
	try {
		JSON.stringify(value)
	} catch {
		throw new Error(`${label} must be JSON-serializable`)
	}
}

export function errorMessage(error: unknown): string {
	if (error instanceof Error && error.message) return error.message
	if (typeof error === 'string' && error.trim()) return error.trim()
	try {
		return JSON.stringify(error)
	} catch {
		return 'Unknown extension compile error'
	}
}

export class InteractionValidationError extends Error {
	constructor(
		message: string,
		public readonly causeError?: unknown,
	) {
		super(causeError instanceof Error && causeError.message ? causeError.message : message)
		this.name = 'InteractionValidationError'
	}
}

export function isValidationError(error: unknown): error is InteractionValidationError {
	return error instanceof InteractionValidationError
}
