import { readFileSync } from 'node:fs'
import { resolve } from 'pathe'
import { applyCatalogSync, planCatalogSync } from '@pluxel-internal/pncat/sync'
import { dependencyPolicy } from '../../scripts/dependency-policy.mjs'
import { assertDevelopmentBinding, developmentSource, type DevelopmentSource } from './setup'

export function readDependencyPolicy(
	source: DevelopmentSource = developmentSource(),
): Record<string, string> {
	if (source.kind === 'git')
		return dependencyPolicy(readFileSync(resolve(source.root, 'pnpm-workspace.yaml'), 'utf8'))
	const path = resolve(source.root, 'dist/resources/dependency-policy.json')
	const policy: unknown = JSON.parse(readFileSync(path, 'utf8'))
	if (
		!policy ||
		typeof policy !== 'object' ||
		Array.isArray(policy) ||
		Object.values(policy).some((range) => typeof range !== 'string')
	)
		throw new Error(`Invalid bundled dependency policy: ${path}`)
	return policy as Record<string, string>
}

export async function planWorkspaceDependencies(root: string, source = developmentSource()) {
	assertDevelopmentBinding(root, source)
	return planCatalogSync({
		root,
		command: 'pluxel pncat',
		versions: readDependencyPolicy(source),
		configModule: resolve(
			source.root,
			source.kind === 'git' ? 'packages/cli/dist/pncat-config.mjs' : 'dist/pncat-config.mjs',
		),
	})
}

export async function diagnoseWorkspaceDependencies(root: string, source = developmentSource()) {
	const plan = await planWorkspaceDependencies(root, source)
	return [
		...plan.conflicts,
		...plan.changes.map(
			(change) =>
				`Dependency drift in ${change.file} (${change.field}.${change.name}): ${change.before ?? '(missing)'} → ${change.after}. Run pluxel workspace sync --root ${JSON.stringify(root)}, then install dependencies.`,
		),
	]
}

export async function syncWorkspaceDependencies(
	root: string,
	log: (...args: unknown[]) => void,
	source = developmentSource(),
) {
	const plan = await planWorkspaceDependencies(root, source)
	if (plan.conflicts.length > 0) throw new Error(plan.conflicts.join('\n'))
	await applyCatalogSync(plan)
	for (const change of plan.changes)
		log(
			`${change.file}: ${change.field}.${change.name}: ${change.before ?? '(missing)'} → ${change.after}`,
		)
	return plan.changes.length
}
