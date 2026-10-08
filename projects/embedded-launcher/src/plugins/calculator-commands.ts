import { BasePlugin, Plugin } from '@pluxel/core'
import { defineCommand, Result } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'
import { Commands } from '@pluxel/services/commands'
import { Native } from '@embedded-launcher/sdk'
import { Calculator } from './calculator'
import { CliCarrier } from './cli-carrier'

@Plugin({ displayName: 'Calculator Commands' })
export class CalculatorCommands extends BasePlugin {
	constructor(
		private readonly calculator: Calculator,
		private readonly cli: CliCarrier,
	) {
		super()
	}
	protected override init() {
		const native = this.ctx.require(Native)
		const command = defineCommand({
			name: 'calculator.calculate',
			description: 'Calculate through the shared Calculator and native bridge',
			input: obj({ expression: Type.String() }),
			execute: async ({ expression }) => {
				let calculation: ReturnType<Calculator['calculate']>
				try {
					calculation = this.calculator.calculate(expression)
				} catch (error) {
					if (
						!(
							error instanceof TypeError ||
							error instanceof RangeError ||
							error instanceof SyntaxError
						)
					)
						throw error
					return Result.err({
						code: 'REJECTED',
						reason: 'invalid_expression',
						message: error.message,
					})
				}
				const echo = await native.echo(calculation.text)
				return Result.ok({ ...calculation, echo })
			},
		})
		this.ctx.require(Commands).register(command)
		this.cli.publish(command)
	}
}
