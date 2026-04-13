import type { RuleTester } from 'oxlint/plugins-dev'
import type {
	DiagnosticData,
	OxNode,
	OxRule,
	OxRuleContext,
	OxRuleMeta,
	OxVisitor,
	OxDiagnostic,
} from '../types.ts'

type NativeOxlintRule = Parameters<RuleTester['run']>[1]

function asNativeRule(rule: OxRule): NativeOxlintRule {
	return rule as unknown as NativeOxlintRule
}

export function createRule(
	meta: OxRuleMeta,
	create: (context: OxRuleContext) => OxVisitor,
): OxRule {
	return { meta, create }
}

export function report(
	context: OxRuleContext,
	node: OxNode,
	messageId: string,
	data?: DiagnosticData,
	diagnostic?: Omit<OxDiagnostic, 'node' | 'messageId' | 'data'>,
): void {
	context.report({ node, messageId, data, ...diagnostic })
}
