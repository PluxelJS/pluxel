import {
	defineCommand,
	Result,
	type CommandFailure,
} from '../../../../packages/commands/src/index.js'
import { Type, obj } from '../../../../packages/commands/src/typebox.js'
import type { ReceiptV2 } from './dto-updated.js'

export const writeNewOutput = defineCommand({
	name: 'records.write',
	description: 'Write a record and return its committed receipt.',
	input: obj({
		id: Type.String({ description: 'Record ID' }),
		offset: Type.Transform(Type.String()).Decode(Number).Encode(String),
		description: Type.Optional(Type.String({ default: 'business value' })),
	}),
	execute(input): Result<ReceiptV2, CommandFailure> {
		return Result.ok({
			operationId: `${input.id}:${input.offset}`,
			committed: true,
			trackingCode: 'updated',
			counts: { accepted: 1, rejected: 0 },
		})
	},
})
