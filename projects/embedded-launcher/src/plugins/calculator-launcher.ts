import { BasePlugin, Plugin } from '@pluxel/core'
import { Launcher, Clipboard } from '@embedded-launcher/sdk'
import { Calculator } from './calculator'
import { calculatorSubtitle } from './calculator-label'
@Plugin({ displayName: 'Calculator Launcher' })
export class CalculatorLauncher extends BasePlugin {
	constructor(private readonly calculator: Calculator) {
		super()
	}
	protected override init() {
		const clipboard = this.ctx.require(Clipboard)
		this.ctx.require(Launcher).register('calculator', async ({ text }) => {
			if (!text.trim()) return []
			let result: ReturnType<Calculator['calculate']>
			try {
				result = this.calculator.calculate(text)
			} catch (error) {
				if (
					error instanceof TypeError ||
					error instanceof RangeError ||
					error instanceof SyntaxError
				)
					return []
				throw error
			}
			return [
				{
					id: 'result',
					title: result.text,
					subtitle: calculatorSubtitle(text),
					action: {
						label: '复制结果',
						execute: async (signal) => ({ ...(await clipboard.write(result.text, signal)) }),
					},
				},
			]
		})
	}
}
