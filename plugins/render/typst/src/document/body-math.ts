import { parse, parseAst, type AstExpr, type SyntaxNode } from '@r4ai/typst-ast-node'

const symbols = new Set([
	'alpha',
	'beta',
	'gamma',
	'delta',
	'epsilon',
	'zeta',
	'eta',
	'theta',
	'iota',
	'kappa',
	'lambda',
	'mu',
	'nu',
	'xi',
	'omicron',
	'pi',
	'rho',
	'sigma',
	'tau',
	'upsilon',
	'phi',
	'chi',
	'psi',
	'omega',
	'Gamma',
	'Delta',
	'Theta',
	'Lambda',
	'Xi',
	'Pi',
	'Sigma',
	'Phi',
	'Psi',
	'Omega',
	'infinity',
	'sum',
	'prod',
	'integral',
	'partial',
	'nabla',
	'times',
	'div',
	'dot',
	'plusminus',
	'in',
	'subset',
	'supset',
	'union',
	'inter',
	'approx',
	'equiv',
	'neq',
	'le',
	'ge',
	'AA',
	'BB',
	'CC',
	'NN',
	'QQ',
	'RR',
	'ZZ',
])
const mathCalls: Readonly<Record<string, number>> = {
	frac: 2,
	sqrt: 1,
	root: 2,
	abs: 1,
	norm: 1,
	floor: 1,
	ceil: 1,
	sin: 1,
	cos: 1,
	tan: 1,
	ln: 1,
	log: 1,
	exp: 1,
}

function validMath(expr: AstExpr): boolean {
	switch (expr.kind) {
		case 'space':
		case 'linebreak':
		case 'mathText':
		case 'mathShorthand':
		case 'mathAlignPoint':
		case 'mathPrimes':
		case 'str':
		case 'escape':
			return true
		case 'mathIdent':
			return symbols.has(expr.name)
		case 'math':
			return expr.body.every(validMath)
		case 'mathDelimited':
			return validMath(expr.open) && expr.body.every(validMath) && validMath(expr.close)
		case 'mathFrac':
			return validMath(expr.num) && validMath(expr.denom)
		case 'mathRoot':
			return validMath(expr.radicand)
		case 'mathAttach':
			return (
				validMath(expr.base) &&
				(!expr.bottom || validMath(expr.bottom)) &&
				(!expr.top || validMath(expr.top))
			)
		case 'funcCall':
			return (
				expr.callee.kind === 'mathIdent' &&
				Object.hasOwn(mathCalls, expr.callee.name) &&
				expr.args.length === mathCalls[expr.callee.name] &&
				expr.args.every((arg) => arg.kind === 'pos' && validMath(arg.expr))
			)
		default:
			return false
	}
}

function mathTokens(node: SyntaxNode, tokens: string[]): boolean {
	// An embedded code expression can have the same AST kind as a literal in math.
	// Check the concrete mode marker before using any of the checked math tokens.
	if (['Hash', 'LineComment', 'BlockComment', 'Dollar', 'Error'].includes(node.kind)) return false
	if (node.children.length > 0) return node.children.every((child) => mathTokens(child, tokens))
	if (node.text) tokens.push(node.text)
	return true
}

/** Rebuild a checked math expression from concrete tokens, retaining grouping and symbols. */
export function bodyMath(value: unknown, block: boolean): string | undefined {
	if (typeof value !== 'string' || !value.trim() || !value.isWellFormed()) return
	const expression = value.trim()
	const content = block ? ' ' + expression + ' ' : expression
	const framed = '$' + content + '$'
	const syntax = parse(framed, { mode: 'markup' })
	const equation = syntax.root.children[0]
	if (
		syntax.errors.length > 0 ||
		syntax.root.children.length !== 1 ||
		equation?.kind !== 'Equation' ||
		equation.children.length !== (block ? 5 : 3)
	)
		return
	const open = equation.children[0]
	const body = equation.children[block ? 2 : 1]
	const close = equation.children.at(-1)
	if (open?.kind !== 'Dollar' || body?.kind !== 'Math' || close?.kind !== 'Dollar') return
	if (block && (equation.children[1]?.text !== ' ' || equation.children[3]?.text !== ' ')) return
	const tokens: string[] = []
	if (!mathTokens(body, tokens)) return
	const emitted = tokens.join('')
	if (emitted !== expression) return
	const ast = parseAst(framed, { mode: 'markup' })
	if (ast.errors.length > 0 || !Array.isArray(ast.root) || ast.root.length !== 1) return
	const node = ast.root[0]
	if (node?.kind !== 'equation' || node.block !== block || !node.body.every(validMath)) return
	return emitted
}
