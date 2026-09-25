import {
	defineCommand,
	Result,
	type CommandFailure,
} from '../../../../packages/commands/src/index.js'
import { Type, obj } from '../../../../packages/commands/src/typebox.js'
import type { Receipt } from './dto.js'

export const writeNewImplementation = defineCommand({
	name: 'records.write',
	description: 'Write a record and return its committed receipt.',
	input: obj({
		id: Type.String({ description: 'Record ID' }),
		offset: Type.Transform(Type.String()).Decode(Number).Encode(String),
		description: Type.Optional(Type.String({ default: 'business value' })),
	}),
	execute(input): Result<Receipt, CommandFailure> {
		return Result.ok({
			operationId: `new-implementation:${input.id}:${input.offset}`,
			committed: true,
			counts: { accepted: 1, rejected: 0 },
		})
	},
})
