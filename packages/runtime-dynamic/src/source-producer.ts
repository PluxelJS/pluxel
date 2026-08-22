import { resolve } from 'node:path'
import type { Context } from '@pluxel/core'
import { requireRouteCapability } from '@pluxel/runtime/internal'
import type { DynamicPluginSource } from './sources'

export type DynamicPluginSourceRequirementCode =
	| 'DYNAMIC_SOURCE_REQUIRED'
	| 'DYNAMIC_SOURCE_NOT_DECLARED'

export class DynamicPluginSourceRequirementError extends Error {
	readonly code: DynamicPluginSourceRequirementCode

	constructor(code: DynamicPluginSourceRequirementCode, message: string) {
		super(message)
		this.name = 'DynamicPluginSourceRequirementError'
		this.code = code
	}
}

type SourceDeclarationReader = {
	hasFile(path: string): boolean
	hasDirectory(path: string, include: readonly string[]): boolean
}

export function requireDynamicPluginSource(ctx: Context, source: DynamicPluginSource): void {
	let reader: SourceDeclarationReader
	try {
		reader = requireRouteCapability(ctx, 'dynamicPluginSources')
	} catch {
		throw new DynamicPluginSourceRequirementError(
			'DYNAMIC_SOURCE_REQUIRED',
			'Dynamic plugin source publication requires a dynamic runtime host.',
		)
	}

	const path = normalizeAbsolutePath(source.path)
	const declared =
		source.kind === 'file'
			? reader.hasFile(path)
			: reader.hasDirectory(
					path,
					source.include.map((pattern) => pattern.replaceAll('\\', '/')),
				)
	if (declared) return

	throw new DynamicPluginSourceRequirementError(
		'DYNAMIC_SOURCE_NOT_DECLARED',
		`Dynamic plugin source is not declared by this host generation: ${path}`,
	)
}

function normalizeAbsolutePath(path: string): string {
	return resolve(path).replaceAll('\\', '/')
}
