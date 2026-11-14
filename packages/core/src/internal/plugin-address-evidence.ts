import { parsePluginNodeAddress, type PluginNodeAddress } from '../plugins/runtime/identity'

// Evidence follows an exact immutable value, never the definition's latest implementation.
// Kept in this browser-safe leaf so Core and generated controls share one registry.
const evidenceByAddress = new WeakMap<PluginNodeAddress, unknown>()
// The marker detects detached evidence from another Core copy; only this leaf's
// WeakMap can authorize a value. No evidence is shared through global state.
const evidenceMarker = Symbol.for('@pluxel/core/plugin-node-address-evidence')

/** @internal A marked value lost the exact registration required for execution evidence. */
export class DetachedPluginNodeAddressError extends TypeError {
	constructor() {
		super('[pluxel/core] Plugin address evidence was copied or detached')
		this.name = 'DetachedPluginNodeAddressError'
	}
}

/** @internal Mint a fresh address without modifying or attaching fields to its caller's value. */
export function createPluginNodeAddressEvidence<A extends PluginNodeAddress>(
	input: A,
	evidence: unknown,
): A {
	const address = parsePluginNodeAddress(input)
	// Parsing preserves A's identity fields; declaration-only associations remain the caller's.
	const reference = Object.freeze({
		...address,
		[evidenceMarker]: Object.freeze({}),
	}) as unknown as A
	evidenceByAddress.set(reference, evidence)
	return reference
}

/** @internal Read before normalization; copied or foreign evidence must fail closed. */
export function readPluginNodeAddressEvidence(address: PluginNodeAddress): unknown {
	if (evidenceByAddress.has(address)) return evidenceByAddress.get(address)
	if (Object.getOwnPropertyDescriptor(address, evidenceMarker)) {
		throw new DetachedPluginNodeAddressError()
	}
	return undefined
}
