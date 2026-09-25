import {
	Type,
	type StaticDecode,
	type StaticEncode,
	type TSchema,
} from '../../../../packages/commands/src/typebox.js'
import type { Result } from '../../../../packages/core/src/better-result.js'
import type { Receipt } from './dto.js'

// A declaration-only stand-in for the proposed Command signature. This experiment
// checks TypeScript's cross-package source information, not a shipped Command API.
interface Command<I, O> {
	readonly name: string
	readonly description: string
	readonly input: TSchema
	execute(input: I): Promise<Result<O, { code: string; message: string }>>
}

declare function defineCommand<S extends TSchema, O>(config: {
	name: string
	description: string
	input: S
	execute(
		input: StaticDecode<S>,
	):
		| Result<O, { code: string; message: string }>
		| Promise<Result<O, { code: string; message: string }>>
}): Command<StaticEncode<S>, O>

export const write = defineCommand({
	name: 'records.write',
	description: 'Creates a receipt.',
	input: Type.Object({
		id: Type.String(),
		count: Type.Number({ default: 1 }),
		offset: Type.Transform(Type.String()).Decode(Number).Encode(String),
	}),
	execute(input): Result<Receipt, { code: string; message: string }> {
		const decodedOffset: number = input.offset
		void decodedOffset
		throw new Error('declaration fixture only')
	},
})

export const read = defineCommand({
	name: 'records.read',
	description: 'Reads a record.',
	input: Type.Object({ id: Type.String() }),
	execute(_input): Result<{ id: string; text: string | null }, { code: string; message: string }> {
		throw new Error('declaration fixture only')
	},
})
