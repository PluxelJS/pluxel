import { ALLOWED_GET_LOGGER_PATHS } from '../shared/constants.ts'
import {
	getNodeField,
	getStaticPropertyName,
	isNodeLike,
	normalizeFilename,
} from '../shared/ast.ts'
import { createRule, report } from '../shared/rule.ts'
import type { OxRule } from '../types.ts'

const noDirectLogtapeGetLogger = createRule(
	{
		type: 'problem',
		docs: { description: 'Keep direct getLogger() usage inside logger infrastructure only' },
		messages: {
			direct:
				'Use `ctx.logger`, `ctx.logger.getDebugChannel(...)`, or pluxel logger helpers instead of importing `getLogger()` directly here.',
		},
	},
	(context) => ({
		ImportDeclaration(node) {
			const source = getNodeField(node, 'source')
			if (source?.value !== '@logtape/logtape') return
			const filename = normalizeFilename(context.filename)
			if (ALLOWED_GET_LOGGER_PATHS.some((segment) => filename.includes(segment))) return
			const specifiers = Array.isArray(node.specifiers) ? node.specifiers : []
			for (const specifier of specifiers) {
				if (!isNodeLike(specifier) || specifier.type !== 'ImportSpecifier') continue
				if (getStaticPropertyName(specifier.imported) !== 'getLogger') continue
				report(context, specifier, 'direct')
			}
		},
	}),
)

export const importsRules: Record<string, OxRule> = {
	'no-direct-logtape-get-logger': noDirectLogtapeGetLogger,
}
