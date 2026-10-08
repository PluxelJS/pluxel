import { BasePlugin, Plugin } from '@pluxel/core'
import * as v from 'valibot'
import { parse } from 'mathjs/number'
import type { MathNode } from 'mathjs'

const Config = v.object({
	precision: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(15)), 10),
})
@Plugin({ displayName: 'Calculator' })
export class Calculator extends BasePlugin {
	private readonly config = this.configs.use(Config)
	private precision = 10
	protected override init() {
		this.precision = this.config.precision
		this.configs.onUpdate(this.config, ({ desired }) => {
			this.precision = desired.precision
		})
	}
	calculate(expression: string) {
		if (expression.length > 256) throw new RangeError('Expression exceeds 256 characters')
		const tree = parse(expression)
		let count = 0
		function validate(node: MathNode, depth: number, parent?: MathNode): void {
			if (++count > 64 || depth > 16)
				throw new RangeError('Expression exceeds 64 nodes or depth 16')
			const allowed =
				node.type === 'ConstantNode' ||
				node.type === 'ParenthesisNode' ||
				(node.type === 'OperatorNode' &&
					['+', '-', '*', '/', '^'].includes((node as unknown as { op: string }).op)) ||
				(node.type === 'FunctionNode' &&
					['sqrt', 'abs', 'sin', 'cos'].includes((node as unknown as { name: string }).name)) ||
				(node.type === 'SymbolNode' &&
					parent?.type === 'FunctionNode' &&
					['sqrt', 'abs', 'sin', 'cos'].includes((node as unknown as { name: string }).name))
			if (!allowed) throw new TypeError(`Unsupported expression node: ${node.type}`)
			node.forEach((child) => validate(child, depth + 1, node))
		}
		validate(tree, 0)
		const value: unknown = tree.compile().evaluate()
		if (typeof value !== 'number' || !Number.isFinite(value))
			throw new RangeError('Result must be a finite number')
		return {
			expression,
			value,
			text: Number(value.toPrecision(this.precision)).toString(),
			precision: this.precision,
		}
	}
}
