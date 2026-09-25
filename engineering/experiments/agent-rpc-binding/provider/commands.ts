import {
	defineCommand,
	Result,
	type CommandFailure,
} from '../../../../packages/commands/src/index.js'
import { Type, obj } from '../../../../packages/commands/src/typebox.js'
import type { Receipt } from './dto.js'

export const write = defineCommand({
	name: 'records.write',
	description: 'Write a record and return its committed receipt.',
	input: obj({
		id: Type.String({ description: 'Record ID' }),
		offset: Type.Transform(Type.String()).Decode(Number).Encode(String),
		description: Type.Optional(Type.String({ default: 'business value' })),
	}),
	execute(input): Result<Receipt, CommandFailure> {
		return Result.ok({
			operationId: `${input.id}:${input.offset}`,
			committed: true,
			counts: { accepted: 1, rejected: 0 },
		})
	},
})

export const read = defineCommand({
	name: 'records.read',
	description: 'Read a record.',
	input: obj({ id: Type.String() }),
	execute({ id }): Result<{ id: string; text: string | null }, CommandFailure> {
		return Result.ok({ id, text: null })
	},
})
