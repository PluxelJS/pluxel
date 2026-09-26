import { describe, expect, it } from 'vitest'
import { Result, defineCommand, type CommandContext } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'
import { RpcStub, RpcTarget } from 'capnweb'
import { toCapnweb } from '../../src/capnweb'

interface NoteContext extends CommandContext {
	readonly actor: string
}

const read = defineCommand({
	name: 'notes.read',
	description: 'Read one note.',
	input: obj({ id: Type.String() }),
	execute({ id }, context: NoteContext) {
		return id === 'missing'
			? Result.err({ code: 'REJECTED' as const, reason: 'not_found', message: 'Missing note' })
			: Result.ok({ id, actor: context.actor })
	},
})

describe('toCapnweb', () => {
	it('calls selected Command methods through a native RpcTarget and keeps context server-side', async () => {
		const Notes = toCapnweb({ read })
		class Library extends RpcTarget {
			notes() {
				return new Notes({ actor: 'alice' })
			}
		}
		using stub = new RpcStub(new Library())
		const notes = await stub.notes()
		expect(await notes.read({ id: 'one' })).toEqual({
			ok: true,
			value: { id: 'one', actor: 'alice' },
		})
		expect(await notes.read({ id: 'missing' })).toEqual({
			ok: false,
			error: { code: 'REJECTED', reason: 'not_found', message: 'Missing note' },
		})
		expect(await notes.read({ id: 1 } as never)).toMatchObject({
			ok: false,
			error: { code: 'INPUT_VALIDATION' },
		})
		expect(Object.getPrototypeOf(new Notes({ actor: 'alice' }))).toHaveProperty('read')
	})

	it('rejects non-JSON success values and reserved method names', async () => {
		const invalid = defineCommand({
			name: 'notes.invalid',
			description: 'Return an invalid value.',
			input: obj({}),
			execute: () => Result.ok({ count: Number.NaN }),
		})
		const Target = toCapnweb({ invalid })
		using stub = new RpcStub(new Target({}))
		expect(await stub.invalid({})).toEqual({
			ok: false,
			error: { code: 'OUTPUT_ENCODING', message: 'Command output is not JSON' },
		})
		expect(() => toCapnweb({ constructor: invalid })).toThrow(TypeError)
		expect(() => toCapnweb(null as never)).toThrow(TypeError)
		expect(() => toCapnweb([invalid] as never)).toThrow(TypeError)
		expect(() => toCapnweb(Object.create({ inherited: invalid }))).toThrow(TypeError)
		expect(() => toCapnweb({ [Symbol('hidden')]: invalid } as never)).toThrow(TypeError)
	})
})
