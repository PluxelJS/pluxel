import type { WorkspacePackageJson } from '../../workspace/package-json'
import { readWorkspacePackageJson, writeWorkspacePackageJson } from '../package-json'
import type { RuleContext, RuleMessages } from './types'
import { ciMetadataRule } from './rules/ci-metadata'
import { pluginDependencyRule } from './rules/plugin-deps'

const RULES = [pluginDependencyRule, ciMetadataRule] as const

export async function applyPackageRules(context: RuleContext): Promise<RuleMessages> {
	const pkg = (await readWorkspacePackageJson(context.packageJsonPath)) as WorkspacePackageJson
	const messages: string[] = []

	for (const rule of RULES) {
		const result = await rule(pkg, context)
		if (!result || result.length === 0) continue
		messages.push(...result)
	}

	if (messages.length === 0) return undefined

	await writeWorkspacePackageJson(context.packageJsonPath, pkg)
	return messages
}
