import { resolve } from 'node:path'
import type { Context } from '@pluxel/core'
import { assertPluginSource, PluginSourceRequiredError } from '@pluxel/host'
import type { DynamicPluginSource } from './declarations'

export type DynamicPluginSourceRequirementCode =
	| 'DYNAMIC_SOURCE_REQUIRED'
	| 'DYNAMIC_SOURCE_NOT_DECLARED'

export class DynamicPluginSourceRequirementError extends Error {
	readonly code: DynamicPluginSourceRequirementCode

	constructor(code: DynamicPluginSourceRequirementCode, message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = 'DynamicPluginSourceRequirementError'
		this.code = code
	}
}

/** Validates publication coverage before a producer starts any effects. */
export function requireDynamicPluginSource(ctx: Context, source: DynamicPluginSource): void {
	try {
		assertPluginSource(ctx, source)
	} catch (cause) {
		if (!(cause instanceof PluginSourceRequiredError)) throw cause
		const code = cause.code
		throw new DynamicPluginSourceRequirementError(
			code === 'SOURCE_REQUIRED' ? 'DYNAMIC_SOURCE_REQUIRED' : 'DYNAMIC_SOURCE_NOT_DECLARED',
			`Dynamic plugin source is not declared by this host: ${resolve(source.path)}`,
			{ cause },
		)
	}
}
