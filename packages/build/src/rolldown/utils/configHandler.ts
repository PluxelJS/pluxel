import type {
	Argument,
	AssignmentTarget,
	Expression,
	ObjectProperty,
	PrivateIdentifier,
	Program,
} from 'oxc-parser'

const WRAPPER_PREFIX = 'const __pluxel_schema__ = '
export type ParseProgram = (code: string, filename: string) => Program

/**
 * Normalize a valibot schema source string using AST-based transforms:
 * - v.optionalAsync(x, ...) -> v.optional(x)
 * - v.pipe / v.pipeAsync: drop v.check / v.transform arguments (and async variants)
 * - strip TS-only wrappers (as/satisfies/instantiation/non-null)
 * - drop comments by re-printing the AST
 */
export function normalizeSchemaSource(
	source: string,
	parseProgram: ParseProgram,
	filename = 'schema.ts',
): string {
	const expr = parseSchemaExpression(source, parseProgram, filename)
	if (!expr) return source.trim()
	return printNormalized(expr, { source, offset: WRAPPER_PREFIX.length })
}

function parseSchemaExpression(
	source: string,
	parseProgram: ParseProgram,
	filename: string,
): Expression | null {
	const wrapped = `${WRAPPER_PREFIX}${source};`
	let program: Program
	try {
		program = parseProgram(wrapped, filename)
	} catch {
		return null
	}
	const stmt = program.body[0]
	if (!stmt || stmt.type !== 'VariableDeclaration') return null
	const decl = stmt.declarations[0]
	if (!decl || decl.type !== 'VariableDeclarator' || !decl.init) return null
	return decl.init
}

type PrintContext = {
	source: string
	offset: number
}

function printNormalized(expr: Expression, ctx: PrintContext): string {
	const normalized = unwrapTs(expr)

	switch (normalized.type) {
		case 'ParenthesizedExpression':
			return `(${printNormalized(normalized.expression, ctx)})`
		case 'ChainExpression':
			return printNormalized(normalized.expression, ctx)
		case 'CallExpression':
			return printCallExpression(normalized, ctx)
		case 'MemberExpression':
			return printMemberExpression(normalized, ctx)
		case 'ObjectExpression':
			return printObjectExpression(normalized, ctx)
		case 'ArrayExpression':
			return printArrayExpression(normalized, ctx)
		case 'Identifier':
			return normalized.name
		case 'Literal':
			return printLiteral(normalized)
		case 'UnaryExpression':
			return printUnaryExpression(normalized, ctx)
		case 'BinaryExpression':
		case 'LogicalExpression':
			return printBinaryExpression(normalized, ctx)
		case 'ConditionalExpression':
			return `${printNormalized(normalized.test, ctx)}?${printNormalized(
				normalized.consequent,
				ctx,
			)}:${printNormalized(normalized.alternate, ctx)}`
		case 'AssignmentExpression':
			return `${printAssignmentTarget(normalized.left, ctx)}${normalized.operator}${printNormalized(
				normalized.right,
				ctx,
			)}`
		case 'SequenceExpression':
			return normalized.expressions.map((item) => printNormalized(item, ctx)).join(',')
		case 'AwaitExpression':
			return `await ${printNormalized(normalized.argument, ctx)}`
		case 'NewExpression':
			return printNewExpression(normalized, ctx)
		case 'TemplateLiteral':
			return printTemplateLiteral(normalized, ctx)
		case 'TaggedTemplateExpression':
			return `${printNormalized(normalized.tag, ctx)}${printTemplateLiteral(
				normalized.quasi,
				ctx,
			)}`
		case 'ArrowFunctionExpression':
		case 'FunctionExpression':
		case 'ClassExpression':
			return sliceOriginal(normalized, ctx)
		default:
			return sliceOriginal(normalized, ctx)
	}
}

function unwrapTs(expr: Expression): Expression {
	let current: Expression = expr
	while (true) {
		switch (current.type) {
			case 'TSAsExpression':
			case 'TSSatisfiesExpression':
			case 'TSTypeAssertion':
			case 'TSInstantiationExpression':
			case 'TSNonNullExpression':
				current = current.expression
				continue
			default:
				return current
		}
	}
}

function isExpressionNode(node: { type?: unknown } | null | undefined): node is Expression {
	if (!node || typeof node.type !== 'string') return false
	const type = node.type
	if (type === 'Identifier' || type === 'Literal' || type === 'TemplateLiteral') return true
	if (type === 'MetaProperty' || type === 'Super' || type === 'ThisExpression') return true
	if (type === 'ObjectExpression' || type === 'ArrayExpression') return true
	return type.endsWith('Expression')
}

function printAssignmentTarget(target: AssignmentTarget, ctx: PrintContext): string {
	return sliceOriginal(target, ctx)
}

function unwrapForDetection(expr: Expression): Expression {
	let current: Expression = expr
	while (true) {
		if (current.type === 'ParenthesizedExpression') {
			current = current.expression
			continue
		}
		if (current.type === 'ChainExpression') {
			current = current.expression
			continue
		}
		switch (current.type) {
			case 'TSAsExpression':
			case 'TSSatisfiesExpression':
			case 'TSTypeAssertion':
			case 'TSInstantiationExpression':
			case 'TSNonNullExpression':
				current = current.expression
				continue
			default:
				return current
		}
	}
}

function getStaticMemberName(expr: Expression): { object: string; property: string } | null {
	const node = unwrapForDetection(expr)
	if (node.type !== 'MemberExpression' || node.computed) return null
	if (node.object.type !== 'Identifier') return null
	if (node.property.type !== 'Identifier') return null
	return { object: node.object.name, property: node.property.name }
}

function isValibotCall(expr: Expression, name: string): boolean {
	const info = getStaticMemberName(expr)
	return Boolean(info && info.object === 'v' && info.property === name)
}

function isValibotCheckOrTransform(expr: Expression): boolean {
	const node = unwrapForDetection(expr)
	if (node.type !== 'CallExpression') return false
	const info = getStaticMemberName(node.callee)
	if (!info || info.object !== 'v') return false
	switch (info.property) {
		case 'check':
		case 'checkAsync':
		case 'transform':
		case 'transformAsync':
		case 'transfrom':
			return true
		default:
			return false
	}
}

function printCallExpression(expr: Expression & { type: 'CallExpression' }, ctx: PrintContext): string {
	const callee = unwrapTs(expr.callee)

	if (isValibotCall(callee, 'optionalAsync')) {
		const first = expr.arguments[0]
		if (!first) {
			return 'v.optional()'
		}
		const arg = first.type === 'SpreadElement' ? first.argument : first
		return `v.optional(${printNormalized(arg, ctx)})`
	}

	const isPipe = isValibotCall(callee, 'pipe')
	const isPipeAsync = !isPipe && isValibotCall(callee, 'pipeAsync')
	if (isPipe || isPipeAsync) {
		const kept: string[] = []
		for (const arg of expr.arguments) {
			if (arg.type === 'SpreadElement') {
				kept.push(`...${printNormalized(arg.argument, ctx)}`)
				continue
			}
			if (isValibotCheckOrTransform(arg)) continue
			kept.push(printNormalized(arg, ctx))
		}
		if (kept.length === 0) {
			return printCallExpressionDefault(expr, ctx)
		}
		if (kept.length === 1) {
			return kept[0]
		}
		const pipeName = isPipe ? 'pipe' : 'pipeAsync'
		return `v.${pipeName}(${kept.join(',')})`
	}

	return printCallExpressionDefault(expr, ctx)
}

function printCallExpressionDefault(
	expr: Expression & { type: 'CallExpression' },
	ctx: PrintContext,
): string {
	const callee = printNormalized(expr.callee, ctx)
	const args = expr.arguments.map((arg) => printArgument(arg, ctx)).join(',')
	const suffix = expr.optional ? '?.' : ''
	return `${callee}${suffix}(${args})`
}

function printArgument(arg: Argument, ctx: PrintContext): string {
	if (arg.type === 'SpreadElement') return `...${printNormalized(arg.argument, ctx)}`
	return printNormalized(arg, ctx)
}

function printMemberExpression(
	expr: Expression & { type: 'MemberExpression' },
	ctx: PrintContext,
): string {
	const object = printNormalized(expr.object, ctx)
	const optional = expr.optional ? '?.' : '.'
	if (expr.computed) {
		if (isExpressionNode(expr.property)) {
			return `${object}${expr.optional ? '?.' : ''}[${printNormalized(expr.property, ctx)}]`
		}
		return `${object}${expr.optional ? '?.' : ''}[${sliceOriginal(
			expr.property as { start: number; end: number },
			ctx,
		)}]`
	}
	if (expr.property.type === 'PrivateIdentifier') {
		return `${object}${optional}#${expr.property.name}`
	}
	if ('name' in expr.property) {
		return `${object}${optional}${expr.property.name}`
	}
	return `${object}${optional}${sliceOriginal(
		expr.property as { start: number; end: number },
		ctx,
	)}`
}

function printObjectExpression(
	expr: Expression & { type: 'ObjectExpression' },
	ctx: PrintContext,
): string {
	const props: string[] = []
	for (const prop of expr.properties) {
		if (prop.type === 'SpreadElement') {
			props.push(`...${printNormalized(prop.argument, ctx)}`)
			continue
		}
		if (prop.type !== 'Property' || prop.kind !== 'init') {
			props.push(sliceOriginal(prop as unknown as Expression, ctx))
			continue
		}

		const key = printPropertyKey(prop, ctx)
		if (prop.shorthand && prop.value.type === 'Identifier' && prop.value.name === key) {
			props.push(key)
			continue
		}
		props.push(`${key}:${printNormalized(prop.value, ctx)}`)
	}
	return `{${props.join(',')}}`
}

function printPropertyKey(prop: ObjectProperty, ctx: PrintContext): string {
	if (prop.computed) {
		if (isExpressionNode(prop.key)) return `[${printNormalized(prop.key, ctx)}]`
		return `[${sliceOriginal(prop.key as { start: number; end: number }, ctx)}]`
	}
	if (prop.key.type === 'Identifier') return prop.key.name
	if (prop.key.type === 'PrivateIdentifier') return `#${prop.key.name}`
	if (prop.key.type === 'Literal') return printLiteral(prop.key)
	if (isExpressionNode(prop.key)) return printNormalized(prop.key, ctx)
	return sliceOriginal(prop.key as { start: number; end: number }, ctx)
}

function printArrayExpression(
	expr: Expression & { type: 'ArrayExpression' },
	ctx: PrintContext,
): string {
	const items = expr.elements.map((item) => {
		if (!item) return ''
		if (item.type === 'SpreadElement') return `...${printNormalized(item.argument, ctx)}`
		return printNormalized(item, ctx)
	})
	return `[${items.join(',')}]`
}

function printNewExpression(
	expr: Expression & { type: 'NewExpression' },
	ctx: PrintContext,
): string {
	const callee = printNormalized(expr.callee, ctx)
	const args = (expr.arguments ?? []).map((arg) => printArgument(arg, ctx)).join(',')
	return `new ${callee}(${args})`
}

function printTemplateLiteral(
	expr: Expression & { type: 'TemplateLiteral' },
	ctx: PrintContext,
): string {
	let out = '`'
	for (let i = 0; i < expr.quasis.length; i++) {
		const quasi = expr.quasis[i]
		out += quasi.value.raw ?? ''
		if (i < expr.expressions.length) {
			out += `\${${printNormalized(expr.expressions[i], ctx)}}`
		}
	}
	out += '`'
	return out
}

function printLiteral(expr: Expression & { type: 'Literal' }): string {
	if ('regex' in expr && expr.regex) {
		return `/${expr.regex.pattern}/${expr.regex.flags}`
	}
	if (typeof expr.value === 'string') return quoteString(expr.value)
	if (typeof expr.value === 'number') return String(expr.value)
	if (typeof expr.value === 'boolean') return expr.value ? 'true' : 'false'
	if (typeof expr.value === 'bigint') return `${expr.value.toString()}n`
	if ('bigint' in expr && expr.bigint) return `${expr.bigint}n`
	if (expr.value === null) return 'null'
	return expr.raw ?? 'null'
}

function printUnaryExpression(
	expr: Expression & { type: 'UnaryExpression' },
	ctx: PrintContext,
): string {
	const op = expr.operator
	const needsSpace = /^[a-z]/i.test(op)
	return `${op}${needsSpace ? ' ' : ''}${printNormalized(expr.argument, ctx)}`
}

function printBinaryExpression(
	expr: Expression & { type: 'BinaryExpression' | 'LogicalExpression' },
	ctx: PrintContext,
): string {
	const op = expr.operator
	const needsSpace = /^[a-z]/i.test(op)
	const space = needsSpace ? ' ' : ''
	return `${printExpressionOrPrivate(expr.left, ctx)}${space}${op}${space}${printNormalized(
		expr.right,
		ctx,
	)}`
}

function printExpressionOrPrivate(value: Expression | PrivateIdentifier, ctx: PrintContext): string {
	if (value.type === 'PrivateIdentifier') return `#${value.name}`
	return printNormalized(value, ctx)
}

function sliceOriginal(expr: { start: number; end: number }, ctx: PrintContext): string {
	const start = Math.max(0, expr.start - ctx.offset)
	const end = Math.max(start, expr.end - ctx.offset)
	return ctx.source.slice(start, end)
}

function quoteString(value: string): string {
	let out = '\''
	for (const ch of value) {
		switch (ch) {
			case '\\':
				out += '\\\\'
				break
			case '\'':
				out += "\\'"
				break
			case '\n':
				out += '\\n'
				break
			case '\r':
				out += '\\r'
				break
			case '\t':
				out += '\\t'
				break
			case '\b':
				out += '\\b'
				break
			case '\f':
				out += '\\f'
				break
			case '\v':
				out += '\\v'
				break
			default: {
				const code = ch.charCodeAt(0)
				if (code < 0x20 || code === 0x2028 || code === 0x2029) {
					out += `\\u${code.toString(16).padStart(4, '0')}`
				} else {
					out += ch
				}
				break
			}
		}
	}
	out += '\''
	return out
}
