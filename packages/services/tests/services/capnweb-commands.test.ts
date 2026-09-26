import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { Result, defineCommand, type CommandContext } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'
import {
	RpcStub,
	RpcTarget,
	deserialize,
	newHttpBatchRpcSession,
	nodeHttpBatchRpcResponse,
	serialize,
} from 'capnweb'
import { toCapnweb } from '../../src/commands/adapters'

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
		expect(deserialize(serialize(await notes.read({ id: 'one' })))).toEqual({
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
		for (const name of ['dup', 'map', 'onRpcBroken', 'catch', 'finally']) {
			expect(() => toCapnweb({ [name]: invalid })).toThrow(TypeError)
		}
	})

	it('rejects values that Cap’n Web would silently change or cannot encode', async () => {
		const unsafe = defineCommand({
			name: 'notes.unsafe',
			description: 'Return unsupported data.',
			input: obj({}),
			execute: () => Result.ok({ nested: JSON.parse('{"toString":"discarded"}') }),
		})
		const deep = defineCommand({
			name: 'notes.deep',
			description: 'Return excessively deep data.',
			input: obj({}),
			execute: () =>
				Result.ok(Array.from({ length: 270 }).reduce<object>((value) => ({ next: value }), {})),
		})
		const Target = toCapnweb({ unsafe, deep })
		using stub = new RpcStub(new Target({}))
		for (const result of [await stub.unsafe({}), await stub.deep({})]) {
			expect(result).toEqual({
				ok: false,
				error: { code: 'OUTPUT_ENCODING', message: 'Command output is not JSON' },
			})
		}
		const unsupportedInput = defineCommand({
			name: 'notes.unsupportedInput',
			description: 'Use a field lost in Cap’n Web transport.',
			input: obj({ nested: Type.Object({ ['toString']: Type.String() }) }),
			execute: () => Result.ok(null),
		})
		expect(() => toCapnweb({ unsupportedInput })).toThrow(TypeError)
	})

	it('keeps trusted contexts separate when remote callers invoke the same method concurrently', async () => {
		const Notes = toCapnweb({ read })
		expectTypeOf<{}>().not.toExtend<ConstructorParameters<typeof Notes>[0]>()
		using alice = new RpcStub(new Notes({ actor: 'alice' }))
		using bob = new RpcStub(new Notes({ actor: 'bob' }))
		const [first, second] = await Promise.all([
			alice.read({ id: 'shared' }),
			bob.read({ id: 'shared' }),
		])
		expect(first).toEqual({ ok: true, value: { id: 'shared', actor: 'alice' } })
		expect(second).toEqual({ ok: true, value: { id: 'shared', actor: 'bob' } })
		expect(await alice.read({ id: 'shared', actor: 'mallory' } as never)).toMatchObject({
			ok: false,
			error: { code: 'INPUT_VALIDATION' },
		})
	})

	it('delivers the generated method through a real Cap’n Web HTTP batch', async () => {
		const fail = defineCommand({
			name: 'notes.fail',
			description: 'Exercise an unexpected dependency failure.',
			input: obj({}),
			execute(): never {
				throw new Error('private dependency detail')
			},
		})
		const Notes = toCapnweb({ read, fail })
		const server = createServer((request, response) => {
			void nodeHttpBatchRpcResponse(request, response, new Notes({ actor: 'server' }))
		})
		try {
			await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
			const address = server.address() as AddressInfo
			using remote = newHttpBatchRpcSession<InstanceType<typeof Notes>>(
				`http://127.0.0.1:${address.port}`,
			)
			const [success, failure] = await Promise.all([remote.read({ id: 'wire' }), remote.fail({})])
			expect(success).toEqual({
				ok: true,
				value: { id: 'wire', actor: 'server' },
			})
			expect(failure).toEqual({
				ok: false,
				error: { code: 'INTERNAL', message: 'Command failed' },
			})
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()))
		}
	})
})
