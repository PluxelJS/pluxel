import {
	defineCommand,
	Result,
	type CommandFailure,
} from '../../../../packages/commands/src/index.js'
import { Type, obj } from '../../../../packages/commands/src/typebox.js'
import type { Receipt } from './dto.js'

export const writeDocs = defineCommand({
	name: 'records.write',
	description: 'Create a durable record and return its receipt.',
	input: obj({
		id: Type.String({ description: 'Stable record identifier' }),
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
