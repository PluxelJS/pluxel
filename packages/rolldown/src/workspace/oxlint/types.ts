export type DiagnosticData = Record<
	string,
	string | number | boolean | bigint | null | undefined
>

export type OxRange = [number, number]

export type OxNode = {
	type: string
	range?: OxRange
	[key: string]: unknown
}

export type OxFix = {
	range: OxRange
	text: string
}

export type OxFixer = {
	insertTextBefore(nodeOrToken: OxNode, text: string): OxFix
	insertTextBeforeRange(range: OxRange, text: string): OxFix
	insertTextAfter(nodeOrToken: OxNode, text: string): OxFix
	insertTextAfterRange(range: OxRange, text: string): OxFix
	remove(nodeOrToken: OxNode): OxFix
	removeRange(range: OxRange): OxFix
	replaceText(nodeOrToken: OxNode, text: string): OxFix
	replaceTextRange(range: OxRange, text: string): OxFix
}

export type OxFixFn = (
	fixer: OxFixer,
) =>
	| OxFix
	| Array<OxFix | null | undefined>
	| IterableIterator<OxFix | null | undefined>
	| null
	| undefined

export type OxSuggestion = {
	desc?: string
	messageId?: string
	data?: DiagnosticData | null
	fix: OxFixFn
}

export type OxDiagnostic = {
	node?: OxNode
	message?: string | null
	messageId?: string | null
	loc?:
		| {
				start: { line: number; column: number }
				end?: { line: number; column: number } | null
		  }
		| { line: number; column: number }
	data?: DiagnosticData | null
	fix?: OxFixFn
	suggest?: OxSuggestion[] | null
}

export type OxVisitor = Record<string, ((node: OxNode) => void) | undefined>

export type OxVisitorWithHooks = OxVisitor & {
	Program?: (node: OxNode) => void
	'Program:exit'?: (node: OxNode) => void
}

export type OxRuleMeta = {
	type?: 'problem' | 'suggestion' | 'layout'
	docs?: {
		description?: string
		recommended?: unknown
		url?: string
		[key: string]: unknown
	}
	messages?: Record<string, string>
	fixable?: 'code' | 'whitespace' | null | undefined
	hasSuggestions?: boolean
}

export type OxRuleContext = {
	id: string
	filename: string
	physicalFilename: string
	cwd: string
	options: readonly unknown[]
	sourceCode: {
		getAncestors(node: OxNode): OxNode[]
		getText(node?: OxNode | null, beforeCount?: number | null, afterCount?: number | null): string
		visitorKeys: Readonly<Record<string, readonly string[]>>
	}
	report(diagnostic: OxDiagnostic): void
}

export type OxRule =
	| {
			meta?: OxRuleMeta
			create(context: OxRuleContext): OxVisitor
	  }
	| {
			meta?: OxRuleMeta
			create?: (context: OxRuleContext) => OxVisitor
			createOnce(context: OxRuleContext): OxVisitorWithHooks
	  }

export interface OxPlugin {
	meta: {
		name: string
	}
	rules: Record<string, OxRule>
}
