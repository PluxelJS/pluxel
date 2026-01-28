import { applyPackageRules } from './package'
import type { RuleContext, RuleMessages } from './types'

export async function runRules(context: RuleContext): Promise<RuleMessages> {
	const messages: string[] = []

	const pkgMessages = await applyPackageRules(context)
	if (pkgMessages) messages.push(...pkgMessages)

	return messages.length > 0 ? messages : undefined
}

