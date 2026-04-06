export interface InteractionContractRef {
	id: string
	version: number
	label?: string
}

export interface InteractionContract<
	TInput = unknown,
	TDraft = unknown,
	TResult = unknown,
> extends InteractionContractRef {
	validateInput?: (value: unknown) => TInput
	validateDraft?: (value: unknown) => TDraft
	validateResult?: (value: unknown) => TResult
}

export function defineInteractionContract<TInput = unknown, TDraft = unknown, TResult = unknown>(
	contract: InteractionContract<TInput, TDraft, TResult>,
): InteractionContract<TInput, TDraft, TResult> {
	const id = String(contract?.id ?? '').trim()
	if (!id) throw new Error('[interaction-contract] id required')
	const version = Number(contract?.version ?? NaN)
	if (!Number.isInteger(version) || version <= 0) {
		throw new Error('[interaction-contract] version must be a positive integer')
	}
	return {
		...contract,
		id,
		version,
		...(typeof contract.label === 'string' && contract.label.trim()
			? { label: contract.label.trim() }
			: {}),
	}
}
