import type { WorkspacePackageJson } from '../../workspace/package-json'
import type { RuleContext } from './types'

/** Generated publication fact consumed by production source admission. */
export function workbenchCapnwebRule(
	pkg: WorkspacePackageJson,
	context: RuleContext,
): string[] | undefined {
	const field = pkg.pluxel
	const manifest =
		field && typeof field === 'object' && !Array.isArray(field)
			? { ...(field as Record<string, unknown>) }
			: {}
	const previous = manifest.workbenchCapnweb
	const next = context.workbenchCapnwebVersion
	if (previous === next) return undefined
	if (next) manifest.workbenchCapnweb = next
	else delete manifest.workbenchCapnweb
	if (Object.keys(manifest).length > 0) pkg.pluxel = manifest
	else delete pkg.pluxel
	return [`pluxel.workbenchCapnweb ${next ? `set to ${next}` : 'removed'}`]
}
