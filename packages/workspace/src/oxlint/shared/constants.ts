export const LOG_METHODS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
export const ERROR_LOG_METHODS = new Set(['warn', 'error', 'fatal'])
export const CANONICAL_ERROR_KEYS = new Set(['error', 'err'])
export const ERROR_LIKE_IDENTIFIERS = new Set(['error', 'err', 'e'])

export const ALLOWED_TOP_LEVEL_CLASS_WRAPPERS = new Set([
	'Program',
	'ExportDefaultDeclaration',
	'ExportNamedDeclaration',
	'VariableDeclaration',
	'VariableDeclarator',
	'ExpressionStatement',
	'AssignmentExpression',
	'ParenthesizedExpression',
	'SequenceExpression',
	'TSAsExpression',
	'TSSatisfiesExpression',
	'TSTypeAssertion',
])

export const ALLOWED_GET_LOGGER_PATHS = [
	'/packages/core/src/logger/',
	'/packages/runtime/src/logger/',
	'/packages/hmr/src/dev/hmr/internals.ts',
]
