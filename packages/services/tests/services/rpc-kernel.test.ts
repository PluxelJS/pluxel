import { defineCommand, Result, type CommandContext, type DirectCommand } from '@pluxel/commands'
import { obj, Type } from '@pluxel/commands/typebox'
import type { Context } from '@pluxel/core'
import { BasePlugin, Plugin } from '@pluxel/core/internal/test'
import { createServiceInternalTestHarness } from '@pluxel/services/internal/test'
import { describe, expect, it } from 'vitest'
import { RpcKernel, type RpcBuildPublication } from '../../src/rpc/kernel'

interface ActorContext extends CommandContext {
	actorId: string
}

function artifact(
	id: string,
	hash: string,
	commands: Record<string, DirectCommand<any, unknown, any>>,
	details: Readonly<{
		declaration?: string
		inputType?: string
		successType?: string
	}> = {},
): RpcBuildPublication {
	return {
		api: { id, commands },
		bindings: { ...commands },
		artifact: {
			format: 'pluxel-rpc-artifact-v1',
			integrity: 'a'.repeat(64),
			contract: { id, hash },
			methods: Object.entries(commands).map(([method, command]) => ({
				method,
				command: command.name,
				description: command.descriptor.description,
				inputSchema: command.descriptor.inputSchema,
			})),
			types: Object.keys(commands).map((method) => ({
				method,
				input: details.inputType ?? 'unknown',
				success: details.successType ?? 'unknown',
			})),
			declaration:
				details.declaration ?? '// Test fixture declaration from a trusted build artifact',
		},
	}
}

@Plugin({ displayName: 'RPC test publisher' })
class RpcOwner extends BasePlugin {
	get owner(): Context {
		return this.ctx
	}
}

describe('private RPC publish/session kernel', () => {
	it('hides denied methods throughout search and describe without changing the approved contract', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })
		host.add(RpcOwner).start(RpcOwner)
		await host.commit()
		const trusted = new WeakMap<object, RpcBuildPublication['bindings']>()
		const kernel = new RpcKernel(host.ctx, {
			verifyArtifact: (builtArtifact) => trusted.get(builtArtifact),
		})
		const read = defineCommand({
			name: 'notes.read',
			description: 'Read a note.',
			input: obj({}),
			execute: () => Result.ok('visible'),
		})
		const write = defineCommand({
			name: 'notes.write',
			description: 'Secret write operation.',
			input: obj({}),
			execute: () => Result.ok('hidden'),
		})
		const built = artifact(
			'notes',
			'7'.repeat(64),
			{ read, write },
			{
				declaration: `export type RpcResult<T> = { readonly ok: true; readonly value: T };
export interface RpcApi {
  "read"(input: unknown): Promise<RpcResult<unknown>>;
  "write"(input: unknown): Promise<RpcResult<unknown>>;
}
export interface RpcClient { open(id: "notes"): RpcApi; }
`,
			},
		)
		trusted.set(built.artifact, built.bindings)
		let allowRead = true
		const publication = kernel.publish(host.require(RpcOwner).owner, built, {
			authorize: ({ method }) => method === 'read' && allowRead,
		})
		const session = kernel.createSession({
			principal: 'alice',
			access: [publication.contract],
		})
		const found = await session.search({ query: 'notes' })
		expect(found.items).toEqual([
			{
				id: 'notes',
				hash: publication.contract.hash,
				operations: [{ method: 'read', description: 'Read a note.' }],
			},
		])
		const deniedSearch = await session.search({ query: 'secret' })
		expect(deniedSearch.items).toEqual([])
		const [description] = await session.describe({ apis: ['notes'] })
		expect(description?.hash).toBe(publication.contract.hash)
		expect(description?.methods.map(({ method }) => method)).toEqual(['read'])
		expect(description?.types.map(({ method }) => method)).toEqual(['read'])
		expect(description?.declaration).toContain('"read"(input: unknown)')
		expect(description?.declaration).not.toContain('"write"')
		expect(await session.call({ id: 'notes', method: 'write', input: {} })).toMatchObject({
			ok: false,
			error: { code: 'FORBIDDEN', outcome: 'not_started' },
		})
		allowRead = false
		expect(session.isDescriptionCurrent(description!)).toBe(true)
		const hiddenSearch = await session.search({ query: 'notes' })
		expect(hiddenSearch.items).toEqual([])
		expect(await session.call({ id: 'notes', method: 'read', input: {} })).toMatchObject({
			ok: false,
			error: { code: 'FORBIDDEN', outcome: 'not_started' },
		})
		await expect(session.describe({ apis: ['notes'] })).rejects.toThrow('RPC API unavailable')
		await session.close()
	})

	it('searches only the visible stable catalog and returns session-pinned artifact descriptions', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })
		host.add(RpcOwner).start(RpcOwner)
		await host.commit()
		const trusted = new WeakMap<object, RpcBuildPublication['bindings']>()
		const kernel = new RpcKernel(host.ctx, {
			verifyArtifact: (builtArtifact) => trusted.get(builtArtifact),
		})
		const allowed = new Set(
			Array.from({ length: 12 }, (_, index) => `api${String(index).padStart(2, '0')}`),
		)
		const handles = new Map<string, ReturnType<RpcKernel['publish']>>()
		const builds = new Map<string, RpcBuildPublication>()
		const declarations = new Map<string, string>()
		let observedPrincipal: unknown
		for (const index of Array.from({ length: 12 }, (_, offset) => 11 - offset)) {
			const id = `api${String(index).padStart(2, '0')}`
			const command = defineCommand({
				name: `${id}.say`,
				description: `Say from ${id}.`,
				input: obj({ text: Type.String() }),
				execute({ text }) {
					return Result.ok(text)
				},
			})
			const declaration = `export interface ${id}Api { say(input: { text: string }): Promise<RpcResult<string>> }`
			const built = artifact(
				id,
				index.toString(16).padStart(64, '0'),
				{ say: command },
				{
					declaration,
					inputType: '{ text: string }',
					successType: 'string',
				},
			)
			declarations.set(id, declaration)
			trusted.set(built.artifact, built.bindings)
			builds.set(id, built)
			handles.set(
				id,
				kernel.publish(host.require(RpcOwner).owner, built, {
					authorize: ({ id: current, principal }) => {
						observedPrincipal = principal
						return allowed.has(current)
					},
				}),
			)
			Reflect.set(built.artifact, 'declaration', 'mutated after publication')
		}
		const access = [...handles.values()].map((handle) => handle.contract)
		const session = kernel.createSession({ principal: 'alice', access })
		expect(Reflect.set(session, 'principal', 'bob')).toBe(false)
		expect(Object.getOwnPropertyDescriptor(session, 'principal')).toMatchObject({
			writable: false,
			configurable: false,
		})
		const firstPage = await session.search({ query: '' })
		expect(observedPrincipal).toBe('alice')
		expect(firstPage.items.map(({ id }) => id)).toEqual(
			Array.from({ length: 10 }, (_, index) => `api${String(index).padStart(2, '0')}`),
		)
		expect(firstPage.hasMore).toBe(true)
		expect(Object.isFrozen(firstPage.items[0]?.operations)).toBe(true)
		const matches = await session.search({ query: 'SAY FROM API0', limit: 3 })
		expect(matches.items.map(({ id }) => id)).toEqual(['api00', 'api01', 'api02'])
		expect(matches.hasMore).toBe(true)
		await expect(session.search({ query: '', limit: 51 })).rejects.toThrow(/between 1 and 50/)
		const descriptions = await session.describe({ apis: ['api00', 'api02'] })
		expect(descriptions.map(({ id }) => id)).toEqual(['api00', 'api02'])
		expect(descriptions[0]?.declaration).toBe(declarations.get('api00'))
		expect(descriptions[0]?.types).toEqual([
			{ method: 'say', input: '{ text: string }', success: 'string' },
		])
		expect(descriptions[0]?.sessionId).toBe(descriptions[1]?.sessionId)
		expect(descriptions[0]?.generation).toBe(handles.get('api00')?.generation)
		expect(Object.isFrozen(descriptions[0]?.methods[0]?.inputSchema)).toBe(true)
		expect(session.isDescriptionCurrent(descriptions[0]!)).toBe(true)
		expect(session.isDescriptionCurrent({ ...descriptions[0]! })).toBe(false)
		const other = kernel.createSession({ principal: 'bob', access })
		expect(other.isDescriptionCurrent(descriptions[0]!)).toBe(false)
		await expect(session.describe({ apis: ['unknown'] })).rejects.toThrow(/RPC API unavailable/)
		allowed.delete('api02')
		const deniedSearch = await session.search({ query: 'api02' })
		expect(deniedSearch.items).toEqual([])
		await expect(session.describe({ apis: ['api02'] })).rejects.toThrow(/RPC API unavailable/)
		session.revoke(['api00'])
		expect(session.isDescriptionCurrent(descriptions[0]!)).toBe(false)
		await expect(session.describe({ apis: ['api00'] })).rejects.toThrow(/RPC API unavailable/)
		handles.get('api03')!.dispose()
		const oldDescriptions = await session.describe({ apis: ['api04'] })
		const staleDescription = oldDescriptions[0]!
		expect(session.isDescriptionCurrent(staleDescription)).toBe(true)
		handles.get('api04')!.dispose()
		expect(session.isDescriptionCurrent(staleDescription)).toBe(false)
		const replacement = kernel.publish(host.require(RpcOwner).owner, builds.get('api04')!)
		expect(replacement.generation).toBe(handles.get('api04')!.generation + 1)
		expect(session.isDescriptionCurrent(staleDescription)).toBe(false)
		const newSession = kernel.createSession({ principal: 'carol', access: [replacement.contract] })
		const newDescriptions = await newSession.describe({ apis: ['api04'] })
		const newDescription = newDescriptions[0]!
		expect(newDescription.generation).toBe(replacement.generation)
		expect(newSession.isDescriptionCurrent(newDescription)).toBe(true)
		expect(session.isDescriptionCurrent(newDescription)).toBe(false)
		await Promise.all([session.close(), other.close(), newSession.close()])
	})

	it('rejects discovery when authorization faults after another API was visible', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })
		host.add(RpcOwner).start(RpcOwner)
		await host.commit()
		const trusted = new WeakMap<object, RpcBuildPublication['bindings']>()
		const kernel = new RpcKernel(host.ctx, {
			verifyArtifact: (builtArtifact) => trusted.get(builtArtifact),
		})
		const command = defineCommand({
			name: 'records.read',
			description: 'Read a record.',
			input: obj({}),
			execute: () => Result.ok('record'),
		})
		const fault = new Error('private authorization detail')
		const publications = ['available', 'broken'].map((id) => {
			const built = artifact(id, id === 'available' ? '1'.repeat(64) : '2'.repeat(64), {
				read: command,
			})
			trusted.set(built.artifact, built.bindings)
			return kernel.publish(host.require(RpcOwner).owner, built, {
				async authorize() {
					await Promise.resolve()
					if (id === 'broken') throw fault
					return true
				},
			})
		})
		const session = kernel.createSession({
			principal: 'alice',
			access: publications.map(({ contract }) => contract),
		})
		await expect(session.search({ query: '' })).rejects.toMatchObject({
			message: 'RPC discovery authorization failed',
			cause: fault,
		})
		await expect(session.describe({ apis: ['available', 'broken'] })).rejects.toMatchObject({
			message: 'RPC discovery authorization failed',
			cause: fault,
		})
		await session.close()
	})

	it('omits an API revoked while another discovery authorization is pending', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })
		host.add(RpcOwner).start(RpcOwner)
		await host.commit()
		const trusted = new WeakMap<object, RpcBuildPublication['bindings']>()
		const kernel = new RpcKernel(host.ctx, {
			verifyArtifact: (builtArtifact) => trusted.get(builtArtifact),
		})
		const command = defineCommand({
			name: 'records.read',
			description: 'Read a record.',
			input: obj({}),
			execute: () => Result.ok('record'),
		})
		const pending = Promise.withResolvers<void>()
		const entered = Promise.withResolvers<void>()
		const publications = ['first', 'slow'].map((id) => {
			const built = artifact(id, id === 'first' ? '1'.repeat(64) : '2'.repeat(64), {
				read: command,
			})
			trusted.set(built.artifact, built.bindings)
			return kernel.publish(host.require(RpcOwner).owner, built, {
				async authorize() {
					if (id === 'slow') {
						entered.resolve()
						await pending.promise
					}
					return true
				},
			})
		})
		const session = kernel.createSession({
			principal: 'alice',
			access: publications.map(({ contract }) => contract),
		})
		const search = session.search({ query: '' })
		await entered.promise
		session.revoke(['first'])
		pending.resolve()
		const result = await search
		expect(result.items.map(({ id }) => id)).toEqual(['slow'])
		await session.close()
	})

	it('rejects an oversized selected description without truncating APIs', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })
		host.add(RpcOwner).start(RpcOwner)
		await host.commit()
		const trusted = new WeakMap<object, RpcBuildPublication['bindings']>()
		const kernel = new RpcKernel(host.ctx, {
			maxDescriptionBytes: 1_100,
			verifyArtifact: (builtArtifact) => trusted.get(builtArtifact),
		})
		const handles: ReturnType<RpcKernel['publish']>[] = []
		for (const id of ['left', 'right']) {
			const command = defineCommand({
				name: `${id}.read`,
				description: 'Read.',
				input: obj({}),
				execute: () => Result.ok(id),
			})
			const built = artifact(
				id,
				'2'.repeat(64),
				{ read: command },
				{
					declaration: `export interface ${id}Api { ${'x'.repeat(500)} }`,
				},
			)
			trusted.set(built.artifact, built.bindings)
			handles.push(kernel.publish(host.require(RpcOwner).owner, built))
		}
		const session = kernel.createSession({
			principal: 'alice',
			access: handles.map(({ contract }) => contract),
		})
		await expect(session.describe({ apis: ['left', 'right'] })).rejects.toThrow(/exceed budget/)
		const leftDescription = await session.describe({ apis: ['left'] })
		expect(leftDescription.map(({ id }) => id)).toEqual(['left'])
		await session.close()
	})

	it('binds exact artifact, contract and generation; rechecks policy and projects Results', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })
		host.add(RpcOwner).start(RpcOwner)
		await host.commit()
		const trusted = new WeakMap<object, RpcBuildPublication['bindings']>()
		const kernel = new RpcKernel(host.ctx, {
			maxOutputBytes: 512,
			verifyArtifact: (builtArtifact) => trusted.get(builtArtifact),
		})
		let allowed = true
		let executions = 0
		const read = defineCommand({
			name: 'records.read',
			description: 'Read a record.',
			input: obj({ id: Type.String() }),
			execute({ id }, context: ActorContext) {
				executions++
				return id === 'missing'
					? Result.err({
							code: 'REJECTED',
							reason: 'not_found',
							message: 'Missing record',
							cause: new Error('private'),
						})
					: Result.ok({ id, actorId: context.actorId })
			},
		})
		const publication = artifact('records', 'b'.repeat(64), { read })
		expect(() => kernel.publish(host.require(RpcOwner).owner, publication)).toThrow(
			/untrusted build artifact/,
		)
		trusted.set(publication.artifact, publication.bindings)
		const options = {
			authorize: () => allowed,
			context: ({ principal }: { principal: unknown }) => ({ actorId: principal as string }),
		}
		const handle = kernel.publish(host.require(RpcOwner).owner, publication, options)
		options.authorize = () => false
		expect(() =>
			kernel.createSession({ principal: 'alice', access: [{ id: 'records', hash: 'wrong' }] }),
		).toThrow(/RPC access does not match/)
		const session = kernel.createSession({ principal: 'alice', access: [handle.contract] })
		expect(Object.hasOwn(session, 'access')).toBe(false)
		expect(Object.hasOwn(session, 'revoked')).toBe(false)
		expect(Object.hasOwn(kernel, 'publications')).toBe(false)
		const SessionConstructor = session.constructor as new (...args: unknown[]) => unknown
		expect(() => new SessionConstructor(Symbol('forged'), kernel, 'mallory', new Map())).toThrow(
			/RPC session must be created by its kernel/,
		)
		expect(
			await session.call({ id: 'records', method: 'read', input: { id: 'one' }, callId: 'c1' }),
		).toEqual({
			ok: true,
			value: { id: 'one', actorId: 'alice' },
		})
		const rejected = await session.call({
			id: 'records',
			method: 'read',
			input: { id: 'missing' },
			callId: 'c2',
		})
		expect(rejected).toEqual({
			ok: false,
			error: {
				code: 'REJECTED',
				message: 'Missing record',
				reason: 'not_found',
				callId: 'c2',
				outcome: 'unknown',
			},
		})
		expect(JSON.stringify(rejected)).not.toContain('private')
		const invalid = await session.call({
			id: 'records',
			method: 'read',
			input: { id: 3 },
			callId: 'c3',
		})
		expect(invalid).toMatchObject({
			ok: false,
			error: { code: 'INPUT_VALIDATION', outcome: 'unknown', callId: 'c3' },
		})
		allowed = false
		expect(
			await session.call({ id: 'records', method: 'read', input: { id: 'denied' }, callId: 'c4' }),
		).toMatchObject({
			ok: false,
			error: { code: 'FORBIDDEN', outcome: 'not_started' },
		})
		expect(executions).toBe(2)
		allowed = true
		session.revoke(['records'])
		Reflect.set(session, 'revoked', new Set())
		expect(
			await session.call({ id: 'records', method: 'read', input: { id: 'revoked' } }),
		).toMatchObject({
			ok: false,
			error: { code: 'FORBIDDEN', outcome: 'not_started' },
		})
		const stale = kernel.createSession({ principal: 'alice', access: [handle.contract] })
		handle.dispose()
		const second = kernel.publish(host.require(RpcOwner).owner, publication, {
			context: ({ principal }) => ({ actorId: principal as string }),
		})
		expect(second.generation).toBe(handle.generation + 1)
		expect(
			await stale.call({ id: 'records', method: 'read', input: { id: 'stale' } }),
		).toMatchObject({
			ok: false,
			error: { code: 'PUBLICATION_GONE', outcome: 'not_started' },
		})
		const fresh = kernel.createSession({ principal: 'bob', access: [second.contract] })
		expect(await fresh.call({ id: 'records', method: 'read', input: { id: 'two' } })).toMatchObject(
			{
				ok: true,
				value: { actorId: 'bob' },
			},
		)
		await Promise.all([session.close(), stale.close(), fresh.close()])
		Reflect.set(session, 'open', true)
		expect(
			await session.call({ id: 'records', method: 'read', input: { id: 'after-close' } }),
		).toMatchObject({ ok: false, error: { code: 'ABORTED', outcome: 'not_started' } })
	})

	it('encodes only bounded JSON and preserves conservative failure outcomes', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })
		host.add(RpcOwner).start(RpcOwner)
		await host.commit()
		const trusted = new WeakMap<object, RpcBuildPublication['bindings']>()
		const kernel = new RpcKernel(host.ctx, {
			maxOutputBytes: 160,
			maxInputBytes: 64,
			verifyArtifact: (builtArtifact) => trusted.get(builtArtifact),
		})
		let runs = 0
		const output = defineCommand({
			name: 'records.output',
			description: 'Output projection cases.',
			input: obj({ mode: Type.String() }),
			execute({ mode }) {
				runs++
				if (mode === 'date') return Result.ok(new Date())
				if (mode === 'large') return Result.ok('x'.repeat(300))
				if (mode === 'error') {
					return Result.err({ code: 'REJECTED', reason: 'oversized', message: 'x'.repeat(300) })
				}
				return Result.ok(undefined)
			},
		})
		const built = artifact('output', 'd'.repeat(64), { output })
		trusted.set(built.artifact, built.bindings)
		const publication = kernel.publish(host.require(RpcOwner).owner, built)
		const session = kernel.createSession({
			principal: { id: 'alice' },
			access: [publication.contract],
		})
		expect(
			await session.call({ id: 'output', method: 'output', input: { mode: 'x'.repeat(100) } }),
		).toMatchObject({ ok: false, error: { code: 'INPUT_VALIDATION', outcome: 'not_started' } })
		expect(runs).toBe(0)
		expect(
			await session.call({ id: 'output', method: 'output', input: { mode: 'date' } }),
		).toMatchObject({
			ok: false,
			error: { code: 'OUTPUT_ENCODING', outcome: 'unknown' },
		})
		expect(
			await session.call({ id: 'output', method: 'output', input: { mode: 'large' } }),
		).toMatchObject({
			ok: false,
			error: { code: 'OUTPUT_LIMIT', outcome: 'unknown' },
		})
		expect(
			await session.call({ id: 'output', method: 'output', input: { mode: 'error' } }),
		).toMatchObject({
			ok: false,
			error: { code: 'OUTPUT_LIMIT', outcome: 'unknown' },
		})
		expect(await session.call({ id: 'output', method: 'output', input: { mode: 'void' } })).toEqual(
			{
				ok: true,
				value: null,
			},
		)
		expect(runs).toBe(4)
		await session.close()
	})

	it('pins callback inputs and refuses a method substitution during authorization', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })
		host.add(RpcOwner).start(RpcOwner)
		await host.commit()
		const trusted = new WeakMap<object, RpcBuildPublication['bindings']>()
		const kernel = new RpcKernel(host.ctx, {
			verifyArtifact: (builtArtifact) => trusted.get(builtArtifact),
		})
		let executedWrite = 0
		const read = defineCommand({
			name: 'records.safeRead',
			description: 'Read safely.',
			input: obj({}),
			execute(_input, context: ActorContext) {
				return Result.ok(context.actorId)
			},
		})
		const write = defineCommand({
			name: 'records.safeWrite',
			description: 'Write safely.',
			input: obj({}),
			execute() {
				executedWrite++
				return Result.ok('written')
			},
		})
		const built = artifact('safe', 'f'.repeat(64), { read, write })
		trusted.set(built.artifact, built.bindings)
		const business = { actorId: 'alice' }
		class Principal {
			constructor(readonly id: string) {}
		}
		let enter!: () => void
		let release!: () => void
		const entered = new Promise<void>((resolve) => (enter = resolve))
		const gate = new Promise<void>((resolve) => (release = resolve))
		const publication = kernel.publish(host.require(RpcOwner).owner, built, {
			context(invocation) {
				expect(Reflect.set(invocation, 'method', 'read')).toBe(false)
				return business
			},
			async authorize({ method, principal }) {
				expect(principal).toBe(identity)
				enter()
				await gate
				return method === 'read' && (principal as { id: string }).id === 'alice'
			},
		})
		const identity = new Principal('alice')
		const session = kernel.createSession({ principal: identity, access: [publication.contract] })
		const readCall = session.call({ id: 'safe', method: 'read', input: {} })
		await entered
		business.actorId = 'mallory'
		release()
		expect(await readCall).toEqual({ ok: true, value: 'alice' })
		expect(await session.call({ id: 'safe', method: 'write', input: {} })).toMatchObject({
			ok: false,
			error: { code: 'FORBIDDEN', outcome: 'not_started' },
		})
		expect(executedWrite).toBe(0)
		await session.close()
	})

	it('blocks a call revoked while asynchronous authorization is pending', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })
		host.add(RpcOwner).start(RpcOwner)
		await host.commit()
		const trusted = new WeakMap<object, RpcBuildPublication['bindings']>()
		const kernel = new RpcKernel(host.ctx, {
			verifyArtifact: (builtArtifact) => trusted.get(builtArtifact),
		})
		let executions = 0
		let enter!: () => void
		let release!: () => void
		const entered = new Promise<void>((resolve) => (enter = resolve))
		const authorize = new Promise<void>((resolve) => (release = resolve))
		const command = defineCommand({
			name: 'records.race',
			description: 'Authorize before invocation.',
			input: obj({}),
			execute() {
				executions++
				return Result.ok('entered')
			},
		})
		const built = artifact('race', 'e'.repeat(64), { run: command })
		trusted.set(built.artifact, built.bindings)
		const publication = kernel.publish(host.require(RpcOwner).owner, built, {
			async authorize() {
				enter()
				await authorize
				return true
			},
		})
		const session = kernel.createSession({ principal: 'alice', access: [publication.contract] })
		const call = session.call({ id: 'race', method: 'run', input: {}, callId: 'race-1' })
		await entered
		session.revoke(['race'])
		release()
		expect(await call).toEqual({
			ok: false,
			error: {
				code: 'FORBIDDEN',
				message: 'RPC access denied',
				callId: 'race-1',
				outcome: 'not_started',
			},
		})
		expect(executions).toBe(0)
		await session.close()
	})

	it('rejects stale command identity and waits for admitted work on session and owner stop', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })
		host.add(RpcOwner).start(RpcOwner)
		await host.commit()
		const trusted = new WeakMap<object, RpcBuildPublication['bindings']>()
		const kernel = new RpcKernel(host.ctx, {
			verifyArtifact: (builtArtifact) => trusted.get(builtArtifact),
		})
		let enter!: () => void
		let release!: () => void
		let observedSignal!: AbortSignal
		let sawAbort!: () => void
		const entered = new Promise<void>((resolve) => (enter = resolve))
		const held = new Promise<void>((resolve) => (release = resolve))
		const aborted = new Promise<void>((resolve) => (sawAbort = resolve))
		const command = defineCommand({
			name: 'records.wait',
			description: 'Wait for a receipt.',
			input: obj({}),
			async execute(_input, context) {
				observedSignal = context.signal!
				context.signal?.addEventListener('abort', sawAbort, { once: true })
				enter()
				await held
				return Result.ok({ operationId: 'committed' })
			},
		})
		const bound = artifact('waits', 'c'.repeat(64), { wait: command })
		trusted.set(bound.artifact, bound.bindings)
		const sameDescriptor = { ...command }
		expect(() =>
			kernel.publish(host.require(RpcOwner).owner, {
				...bound,
				api: { id: 'waits', commands: { wait: sameDescriptor } },
			}),
		).toThrow(/stale Command binding/)
		expect(() =>
			kernel.publish(host.require(RpcOwner).owner, {
				...bound,
				api: { id: 'waits', commands: { wait: sameDescriptor } },
				bindings: { wait: sameDescriptor },
			}),
		).toThrow(/stale Command binding/)
		const handle = kernel.publish(host.require(RpcOwner).owner, bound)
		const session = kernel.createSession({ principal: 'alice', access: [handle.contract] })
		const call = session.call({ id: 'waits', method: 'wait', input: {}, callId: 'held' })
		await entered
		handle.dispose()
		expect(observedSignal.aborted).toBe(false)
		expect(await session.call({ id: 'waits', method: 'wait', input: {} })).toMatchObject({
			ok: false,
			error: { code: 'PUBLICATION_GONE', outcome: 'not_started' },
		})
		let closed = false
		host.stop(RpcOwner)
		let stopped = false
		const stopping = host.commit().then(() => (stopped = true))
		await aborted
		const closing = session.close().then(() => (closed = true))
		await Promise.resolve()
		expect(observedSignal.aborted).toBe(true)
		expect(closed).toBe(false)
		expect(stopped).toBe(false)
		release()
		expect(await call).toEqual({ ok: true, value: { operationId: 'committed' } })
		await Promise.all([closing, stopping])
		expect(closed).toBe(true)
		expect(stopped).toBe(true)
		expect(await session.call({ id: 'waits', method: 'wait', input: {} })).toMatchObject({
			ok: false,
			error: { code: 'ABORTED', outcome: 'not_started' },
		})
	})

	it('provider shutdown aborts and drains an admitted call', async () => {
		const host = await createServiceInternalTestHarness({ workbench: false })
		let release!: () => void
		try {
			host.add(RpcOwner).start(RpcOwner)
			await host.commit()
			const trusted = new WeakMap<object, RpcBuildPublication['bindings']>()
			const kernel = new RpcKernel(host.ctx, {
				verifyArtifact: (builtArtifact) => trusted.get(builtArtifact),
			})
			let enter!: () => void
			let sawAbort!: () => void
			const entered = new Promise<void>((resolve) => (enter = resolve))
			const aborted = new Promise<void>((resolve) => (sawAbort = resolve))
			const held = new Promise<void>((resolve) => (release = resolve))
			const command = defineCommand({
				name: 'records.shutdown',
				description: 'Wait during provider shutdown.',
				input: obj({}),
				async execute(_input, context) {
					context.signal?.addEventListener('abort', sawAbort, { once: true })
					enter()
					await held
					return Result.ok({ operationId: 'committed' })
				},
			})
			const built = artifact('shutdown', '1'.repeat(64), { run: command })
			trusted.set(built.artifact, built.bindings)
			const publication = kernel.publish(host.require(RpcOwner).owner, built)
			const session = kernel.createSession({ principal: 'alice', access: [publication.contract] })
			const call = session.call({ id: 'shutdown', method: 'run', input: {} })
			await entered
			let stopped = false
			const stopping = host.dispose().then(() => (stopped = true))
			await aborted
			expect(stopped).toBe(false)
			release()
			expect(await call).toMatchObject({ ok: true, value: { operationId: 'committed' } })
			await stopping
			expect(stopped).toBe(true)
			expect(await session.call({ id: 'shutdown', method: 'run', input: {} })).toMatchObject({
				ok: false,
				error: { code: 'ABORTED', outcome: 'not_started' },
			})
		} finally {
			release?.()
			await host.dispose()
		}
	})

	it.each(['publication owner', 'provider owner'] as const)(
		'holds a delivered DTO through %s stop and session close',
		async (stoppedOwner) => {
			const host = await createServiceInternalTestHarness({ workbench: false })
			let releaseDelivery: (() => void) | undefined
			try {
				host.add(RpcOwner).start(RpcOwner)
				await host.commit()
				const trusted = new WeakMap<object, RpcBuildPublication['bindings']>()
				const kernel = new RpcKernel(host.ctx, {
					verifyArtifact: (builtArtifact) => trusted.get(builtArtifact),
				})
				const command = defineCommand({
					name: 'records.deliver',
					description: 'Deliver a receipt.',
					input: obj({}),
					execute() {
						return Result.ok({ operationId: 'committed' })
					},
				})
				const built = artifact('deliver', '2'.repeat(64), { run: command })
				trusted.set(built.artifact, built.bindings)
				const publication = kernel.publish(host.require(RpcOwner).owner, built)
				const session = kernel.createSession({ principal: 'alice', access: [publication.contract] })
				const delivery = await session.callForDelivery({ id: 'deliver', method: 'run', input: {} })
				releaseDelivery = delivery.release
				expect(delivery.result).toEqual({ ok: true, value: { operationId: 'committed' } })
				publication.dispose()
				let stopped = false
				const stopping =
					stoppedOwner === 'publication owner'
						? (host.stop(RpcOwner), host.commit().then(() => (stopped = true)))
						: host.dispose().then(() => (stopped = true))
				await new Promise<void>((resolve) => setImmediate(resolve))
				let closed = false
				const closing = session.close().then(() => (closed = true))
				await Promise.resolve()
				expect(stopped).toBe(false)
				expect(closed).toBe(false)
				delivery.release()
				delivery.release()
				await Promise.all([stopping, closing])
				expect(stopped).toBe(true)
				expect(closed).toBe(true)
			} finally {
				releaseDelivery?.()
				await host.dispose()
			}
		},
	)

	it.each([
		['search', 'publication owner'],
		['search', 'provider owner'],
		['describe', 'publication owner'],
		['describe', 'provider owner'],
	] as const)('drains pending %s authorization before %s stop', async (discovery, stoppedOwner) => {
		const host = await createServiceInternalTestHarness({ workbench: false })
		let releaseAuthorization: (() => void) | undefined
		try {
			host.add(RpcOwner).start(RpcOwner)
			await host.commit()
			const trusted = new WeakMap<object, RpcBuildPublication['bindings']>()
			const kernel = new RpcKernel(host.ctx, {
				verifyArtifact: (builtArtifact) => trusted.get(builtArtifact),
			})
			let entered!: () => void
			const authorizationEntered = new Promise<void>((resolve) => (entered = resolve))
			const authorizationHeld = new Promise<void>((resolve) => (releaseAuthorization = resolve))
			let authorizationSignal!: AbortSignal
			const command = defineCommand({
				name: 'records.discover',
				description: 'Discover a record.',
				input: obj({}),
				execute: () => Result.ok('record'),
			})
			const built = artifact('discover', '3'.repeat(64), { read: command })
			trusted.set(built.artifact, built.bindings)
			const publication = kernel.publish(host.require(RpcOwner).owner, built, {
				async authorize({ signal }) {
					authorizationSignal = signal
					entered()
					await authorizationHeld
					return true
				},
			})
			const session = kernel.createSession({ principal: 'alice', access: [publication.contract] })
			const discoveryTask =
				discovery === 'search'
					? session.search({ query: '' })
					: session.describe({ apis: ['discover'] })
			const discoveryResult = discoveryTask.then(
				() => 'resolved',
				(cause: Error) => cause.message,
			)
			await authorizationEntered
			let closed = false
			const closing = session.close().then(() => (closed = true))
			let stopped = false
			let stopping: Promise<boolean>
			if (stoppedOwner === 'publication owner') {
				host.stop(RpcOwner)
				stopping = host.commit().then(() => (stopped = true))
			} else {
				stopping = host.dispose().then(() => (stopped = true))
			}
			await new Promise<void>((resolve) => setImmediate(resolve))
			expect(authorizationSignal.aborted).toBe(true)
			expect(closed).toBe(false)
			expect(stopped).toBe(false)
			releaseAuthorization()
			expect(await discoveryResult).toMatch(/RPC session closed|RPC API unavailable/)
			await Promise.all([closing, stopping])
			expect(closed).toBe(true)
			expect(stopped).toBe(true)
		} finally {
			releaseAuthorization?.()
			await host.dispose()
		}
	})
})
