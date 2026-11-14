import type { WorkspacePackageJson } from '../../workspace/package-json'
import { readWorkspacePackageJson, writeWorkspacePackageJson } from '../package-json'
import type { RuleContext, RuleMessages } from './types'
import { pluginDependencyRule } from './plugin-deps'
import { workbenchCapnwebRule } from './workbench-capnweb'
import { addControlExport, controlEntry } from '../control-exports'

const RULES = [pluginDependencyRule, workbenchCapnwebRule] as const

export async function runRules(context: RuleContext): Promise<RuleMessages> {
	const pkg = (await readWorkspacePackageJson(context.packageJsonPath)) as WorkspacePackageJson
	const messages: string[] = []
	if (context.artifactRoot !== undefined) {
		const pluxel =
			pkg.pluxel && typeof pkg.pluxel === 'object' ? (pkg.pluxel as Record<string, unknown>) : {}
		if (
			pluxel.artifactRoot !== context.artifactRoot ||
			pluxel.nodeArtifacts !== true ||
			pluxel.workbenchArtifacts !== context.workbenchArtifacts
		) {
			pkg.pluxel = {
				...pluxel,
				artifactRoot: context.artifactRoot,
				nodeArtifacts: true,
				workbenchArtifacts: context.workbenchArtifacts,
			}
			messages.push('pluxel.artifactRoot updated')
		}
	}
	if (context.control && context.artifactRoot !== undefined) {
		const directory =
			context.artifactRoot === '.' ? './control' : `./${context.artifactRoot}/control`
		const pluxel =
			pkg.pluxel && typeof pkg.pluxel === 'object' ? (pkg.pluxel as Record<string, unknown>) : {}
		const entry = controlEntry(directory)
		const exports = addControlExport(pkg.exports, entry, pluxel.control, 'exports')
		const publishConfig =
			pkg.publishConfig && typeof pkg.publishConfig === 'object'
				? (pkg.publishConfig as Record<string, unknown>)
				: undefined
		const publishExports =
			publishConfig?.exports === undefined
				? undefined
				: addControlExport(publishConfig.exports, entry, pluxel.control, 'publishConfig.exports')
		if (
			pluxel.control !== `${directory}/manifest.json` ||
			JSON.stringify(pkg.exports) !== JSON.stringify(exports) ||
			(publishExports && JSON.stringify(publishConfig!.exports) !== JSON.stringify(publishExports))
		) {
			pkg.pluxel = { ...pluxel, control: `${directory}/manifest.json` }
			pkg.exports = exports
			if (publishExports) pkg.publishConfig = { ...publishConfig, exports: publishExports }
			messages.push('pluxel.control and ./control export updated')
		}
	}

	for (const rule of RULES) {
		const result = await rule(pkg, context)
		if (!result || result.length === 0) continue
		messages.push(...result)
	}

	if (messages.length === 0) return undefined

	await writeWorkspacePackageJson(context.packageJsonPath, pkg)
	return messages
}
