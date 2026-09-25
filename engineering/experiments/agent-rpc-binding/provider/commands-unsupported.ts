import {
	defineCommand,
	Result,
	type CommandFailure,
} from '../../../../packages/commands/src/index.js'
import { Type, obj } from '../../../../packages/commands/src/typebox.js'

export const anyOutput = defineCommand({
	name: 'records.any',
	description: 'Unsupported untyped result.',
	input: obj({ id: Type.String() }),
	execute(): Result<any, CommandFailure> {
		return Result.ok({ id: 'value' })
	},
})

export const indexedOutput = defineCommand({
	name: 'records.indexed',
	description: 'Unsupported open result.',
	input: obj({ id: Type.String() }),
	execute(): Result<Record<string, string>, CommandFailure> {
		return Result.ok({ id: 'value' })
	},
})

export const dateOutput = defineCommand({
	name: 'records.date',
	description: 'Unsupported native result.',
	input: obj({ id: Type.String() }),
	execute(): Result<Date, CommandFailure> {
		return Result.ok(new Date(0))
	},
})

export const unionInput = defineCommand({
	name: 'records.union',
	description: 'Unsupported union wire schema.',
	input: obj({ id: Type.Union([Type.String(), Type.Integer()]) }),
	execute(): Result<{ accepted: boolean }, CommandFailure> {
		return Result.ok({ accepted: true })
	},
})
