import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { defineCommand, Result, type CommandContext } from '@pluxel/commands'
import { obj, Type } from '@pluxel/commands/typebox'
import { BasePlugin, Plugin } from '@pluxel/core/internal/test'
import { Mcp, mcp, type McpService } from '@pluxel/services/mcp'
import { Commands, commands } from '@pluxel/services/commands'
import { createServiceInternalTestHarness } from '@pluxel/services/internal/test'
import { describe, expect, it } from 'vitest'
import { lowerTestPlugin } from '../helpers/lowered-plugin'

function fixture() {
	const server = new Server({ name: 'pluxel-test', version: '1.0.0' }, { capabilities: {} })
	const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} })
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
	return { server, client, clientTransport, serverTransport }
}

interface NoteContext extends CommandContext {
	actorId: string
}

function checkPublicationTypes(view: McpService) {
	const note = defineCommand({
		name: 'type.note',
		description: 'Check the MCP publication type.',
		input: obj({}),
		execute(_input, context: NoteContext) {
			return Result.ok(context.actorId)
		},
	})
	// @ts-expect-error Required business context needs a factory.
	view.expose(note)
	const invalid = { actorId: 'alice', signal: new AbortController().signal }
	// @ts-expect-error A predeclared factory result cannot overwrite carrier signal.
	view.expose(note, { context: () => invalid })
	view.expose(note, { context: () => ({ actorId: 'alice' }) })
}
void checkPublicationTypes

describe('MCP carrier', () => {
	it('pins context fields before asynchronous authorization', async () => {
		const sdk = fixture()
		const host = await createServiceInternalTestHarness({
			workbench: false,
			services: [mcp({ server: sdk.server, authenticate: () => ({ id: 'alice' }) })],
		})
		const business = { actorId: 'alice' }
		let authorizationStarted!: () => void
		let releaseAuthorization!: () => void
		const entered = new Promise<void>((resolve) => {
			authorizationStarted = resolve
		})
		const authorization = new Promise<void>((resolve) => {
			releaseAuthorization = resolve
		})
		try {
			host.ctx.require(Mcp).expose(
				defineCommand({
					name: 'identity.read',
					description: 'Read the invocation identity.',
					input: obj({}),
					execute(_input, context: NoteContext) {
						return Result.ok(context.actorId)
					},
				}),
				{
					context: () => business,
					async authorize() {
						authorizationStarted()
						await authorization
						return true
					},
				},
			)
			await Promise.all([
				sdk.server.connect(sdk.serverTransport),
				sdk.client.connect(sdk.clientTransport),
			])
			const call = sdk.client.callTool({ name: 'identity.read', arguments: {} })
			await entered
			business.actorId = 'mallory'
			releaseAuthorization()
			expect(await call).toMatchObject({ content: [{ type: 'text', text: 'alice' }] })
		} finally {
			releaseAuthorization()
			await sdk.client.close()
			await sdk.server.close()
			await host[Symbol.asyncDispose]()
		}
	})

	it('omits a tool withdrawn while a later discovery authorization waits', async () => {
		const sdk = fixture()
		const host = await createServiceInternalTestHarness({
			workbench: false,
			services: [mcp({ server: sdk.server, authenticate: () => 'alice' })],
		})
		let withdrawn!: { dispose(): void }
		let authorizationStarted!: () => void
		let releaseAuthorization!: () => void
		const entered = new Promise<void>((resolve) => {
			authorizationStarted = resolve
		})
		const authorization = new Promise<void>((resolve) => {
			releaseAuthorization = resolve
		})
		try {
			const view = host.ctx.require(Mcp)
			withdrawn = view.expose(
				defineCommand({
					name: 'first.tool',
					description: 'First listed tool.',
					input: obj({}),
					execute: () => Result.ok('first'),
				}),
			)
			view.expose(
				defineCommand({
					name: 'second.tool',
					description: 'Authorization waits.',
					input: obj({}),
					execute: () => Result.ok('second'),
				}),
				{
					async authorize() {
						authorizationStarted()
						await authorization
						return true
					},
				},
			)
			await Promise.all([
				sdk.server.connect(sdk.serverTransport),
				sdk.client.connect(sdk.clientTransport),
			])
			const listing = sdk.client.listTools()
			await entered
			withdrawn.dispose()
			releaseAuthorization()
			const listed = await listing
			expect(listed.tools.map((tool) => tool.name)).toEqual(['second.tool'])
		} finally {
			releaseAuthorization()
			await sdk.client.close()
			await sdk.server.close()
			await host[Symbol.asyncDispose]()
		}
	})

	it('exposes explicit commands through the SDK and rechecks current permission', async () => {
		const sdk = fixture()
		let allowed = true
		let runs = 0
		let contextOverride: unknown
		const annotations = { readOnlyHint: true }
		const outputSchema = obj({ id: Type.String(), actorId: Type.String() })
		const host = await createServiceInternalTestHarness({
			workbench: false,
			services: [mcp({ server: sdk.server, authenticate: () => ({ id: 'alice' }) })],
		})
		try {
			@Plugin({ displayName: 'MCP command owner' })
			class Owner extends BasePlugin {
				override init() {
					this.ctx.require(Mcp).expose(
						defineCommand({
							name: 'notes.read',
							description: 'Read a note.',
							input: obj({ id: Type.String({ examples: ['one'] }) }),
							execute({ id }, context: NoteContext) {
								runs++
								return id === 'missing'
									? Result.err({ code: 'REJECTED', reason: 'not_found', message: 'Note missing' })
									: Result.ok({ id, actorId: context.actorId })
							},
						}),
						{
							context: ({ principal }) =>
								(contextOverride ?? { actorId: (principal as { id: string }).id }) as {
									actorId: string
								},
							authorize: () => allowed,
							annotations,
							outputSchema,
						},
					)
				}
			}
			lowerTestPlugin(Owner)
			host.add(Owner)
			host.cfg(Owner).setAutoStart(true)
			host.start(Owner)
			await host.commit()
			await Promise.all([
				sdk.server.connect(sdk.serverTransport),
				sdk.client.connect(sdk.clientTransport),
			])
			const listed = await sdk.client.listTools()
			expect(listed.tools.map((tool) => tool.name)).toEqual(['notes.read'])
			expect(listed.tools[0]?.annotations?.readOnlyHint).toBe(true)
			expect(listed.tools[0]?.inputSchema).toHaveProperty('properties.id.examples', ['one'])
			annotations.readOnlyHint = false
			outputSchema.properties.actorId.description = 'changed after publication'
			const listedAgain = await sdk.client.listTools()
			expect(listedAgain.tools[0]?.annotations?.readOnlyHint).toBe(true)
			expect(listedAgain.tools[0]?.outputSchema?.properties?.actorId).not.toHaveProperty(
				'description',
			)
			const ok = await sdk.client.callTool({ name: 'notes.read', arguments: { id: 'one' } })
			expect(ok.isError).not.toBe(true)
			expect(ok.structuredContent).toEqual({ id: 'one', actorId: 'alice' })
			const rejected = await sdk.client.callTool({
				name: 'notes.read',
				arguments: { id: 'missing' },
			})
			expect(rejected.isError).toBe(true)
			expect(JSON.stringify(rejected)).toContain('not_found')
			contextOverride = []
			const arrayContext = await sdk.client.callTool({
				name: 'notes.read',
				arguments: { id: 'one' },
			})
			expect(arrayContext.isError).toBe(true)
			let getterReads = 0
			contextOverride = {
				get actorId() {
					getterReads++
					return 'alice'
				},
			}
			const getterContext = await sdk.client.callTool({
				name: 'notes.read',
				arguments: { id: 'one' },
			})
			expect(getterContext.isError).toBe(true)
			expect(getterReads).toBe(0)
			expect(runs).toBe(2)
			contextOverride = undefined
			allowed = false
			const hidden = await sdk.client.listTools()
			expect(hidden.tools).toEqual([])
			const denied = await sdk.client.callTool({ name: 'notes.read', arguments: { id: 'one' } })
			expect(denied.isError).toBe(true)
			expect(runs).toBe(2)
			host.remove(Owner)
			await host.commit()
			allowed = true
			const withdrawn = await sdk.client.listTools()
			expect(withdrawn.tools).toEqual([])
			const staleCall = await sdk.client.callTool({ name: 'notes.read', arguments: { id: 'one' } })
			expect(staleCall.isError).toBe(true)
			expect(runs).toBe(2)
		} finally {
			await sdk.client.close()
			await sdk.server.close()
			await host[Symbol.asyncDispose]()
		}
	})

	it('keeps root catalog private and classifies output failures without rerunning work', async () => {
		const sdk = fixture()
		const counts = { badSchema: 0, nonJson: 0, tooLarge: 0 }
		const host = await createServiceInternalTestHarness({
			workbench: false,
			services: [
				commands(),
				mcp({ server: sdk.server, authenticate: () => 'alice', maxOutputBytes: 128 }),
			],
		})
		try {
			@Plugin({ displayName: 'MCP output owner' })
			class Owner extends BasePlugin {
				override init() {
					this.ctx.require(Commands).register(
						defineCommand({
							name: 'private.only',
							description: 'Root catalog only.',
							input: obj({}),
							execute: () => Result.ok('private'),
						}),
					)
					const mcpView = this.ctx.require(Mcp)
					mcpView.expose(
						defineCommand({
							name: 'bad.schema',
							description: 'Returns a value outside outputSchema.',
							input: obj({}),
							execute: () => {
								counts.badSchema++
								return Result.ok({ value: 42 })
							},
						}),
						{ outputSchema: obj({ value: Type.String() }) },
					)
					mcpView.expose(
						defineCommand({
							name: 'bad.json',
							description: 'Returns a Date.',
							input: obj({}),
							execute: () => {
								counts.nonJson++
								return Result.ok(new Date())
							},
						}),
					)
					mcpView.expose(
						defineCommand({
							name: 'bad.limit',
							description: 'Returns too much data.',
							input: obj({}),
							execute: () => {
								counts.tooLarge++
								return Result.ok({ text: 'x'.repeat(256) })
							},
						}),
					)
					mcpView.expose(
						defineCommand({
							name: 'plain.echo',
							description: 'Returns plain text.',
							input: obj({}),
							execute: () => Result.ok('hello'),
						}),
					)
					mcpView.expose(
						defineCommand({
							name: 'bad.default',
							description: 'Does not supply a required output.',
							input: obj({}),
							execute: () => Result.ok({}),
						}),
						{ outputSchema: obj({ value: Type.String({ default: 'not-filled' }) }) },
					)
				}
			}
			lowerTestPlugin(Owner)
			host.add(Owner)
			host.cfg(Owner).setAutoStart(true)
			host.start(Owner)
			await host.commit()
			await Promise.all([
				sdk.server.connect(sdk.serverTransport),
				sdk.client.connect(sdk.clientTransport),
			])
			const listing = await sdk.client.listTools()
			const listed = listing.tools.map((tool) => tool.name)
			expect(listed).toEqual(['bad.schema', 'bad.json', 'bad.limit', 'plain.echo', 'bad.default'])
			expect(listed).not.toContain('private.only')
			const badSchema = await sdk.client.callTool({ name: 'bad.schema', arguments: {} })
			const nonJson = await sdk.client.callTool({ name: 'bad.json', arguments: {} })
			const tooLarge = await sdk.client.callTool({ name: 'bad.limit', arguments: {} })
			const defaulted = await sdk.client.callTool({ name: 'bad.default', arguments: {} })
			expect(badSchema.isError).toBe(true)
			expect(JSON.stringify(badSchema)).toContain('INTERNAL')
			expect(nonJson.isError).toBe(true)
			expect(JSON.stringify(nonJson)).toContain('OUTPUT_ENCODING')
			expect(tooLarge.isError).toBe(true)
			expect(JSON.stringify(tooLarge)).toContain('OUTPUT_LIMIT')
			expect(JSON.stringify(defaulted)).toContain('INTERNAL')
			expect(counts).toEqual({ badSchema: 1, nonJson: 1, tooLarge: 1 })
			const plain = await sdk.client.callTool({ name: 'plain.echo', arguments: {} })
			expect(plain.content).toEqual([{ type: 'text', text: 'hello' }])
			expect(() =>
				host.ctx.require(Mcp).expose(
					defineCommand({
						name: 'bad.transform',
						description: 'Invalid output transform.',
						input: obj({}),
						execute: () => Result.ok({ value: 1 }),
					}),
					{
						outputSchema: obj({
							value: Type.Transform(Type.String()).Decode(Number).Encode(String),
						}),
					},
				),
			).toThrow(/Transform/)
		} finally {
			await sdk.client.close()
			await sdk.server.close()
			await host[Symbol.asyncDispose]()
		}
	})

	it('withdraws lookup synchronously and waits for admitted owner work to exit', async () => {
		const sdk = fixture()
		const host = await createServiceInternalTestHarness({
			workbench: false,
			services: [mcp({ server: sdk.server, authenticate: () => 'alice' })],
		})
		let manualRegistration!: { dispose(): void }
		let manualStarted!: () => void
		let releaseManual!: () => void
		let ownerStarted!: () => void
		let releaseOwner!: () => void
		const manualEntered = new Promise<void>((resolve) => {
			manualStarted = resolve
		})
		const ownerEntered = new Promise<void>((resolve) => {
			ownerStarted = resolve
		})
		const manualWork = new Promise<void>((resolve) => {
			releaseManual = resolve
		})
		const ownerWork = new Promise<void>((resolve) => {
			releaseOwner = resolve
		})
		try {
			@Plugin({ displayName: 'MCP lifetime owner' })
			class Owner extends BasePlugin {
				override init() {
					const mcpView = this.ctx.require(Mcp)
					manualRegistration = mcpView.expose(
						defineCommand({
							name: 'manual.long',
							description: 'Wait for manual release.',
							input: obj({}),
							async execute() {
								manualStarted()
								await manualWork
								return Result.ok({ operationId: 'manual-1' })
							},
						}),
					)
					mcpView.expose(
						defineCommand({
							name: 'owner.long',
							description: 'Wait for owner release.',
							input: obj({}),
							async execute() {
								ownerStarted()
								await ownerWork
								return Result.ok({ operationId: 'owner-1' })
							},
						}),
					)
				}
			}
			lowerTestPlugin(Owner)
			host.add(Owner)
			host.cfg(Owner).setAutoStart(true)
			host.start(Owner)
			await host.commit()
			await Promise.all([
				sdk.server.connect(sdk.serverTransport),
				sdk.client.connect(sdk.clientTransport),
			])
			const manualCall = sdk.client.callTool({ name: 'manual.long', arguments: {} })
			await manualEntered
			manualRegistration.dispose()
			manualRegistration.dispose()
			const afterManualDispose = await sdk.client.listTools()
			expect(afterManualDispose.tools.map((tool) => tool.name)).toEqual(['owner.long'])
			releaseManual()
			expect(JSON.stringify(await manualCall)).toContain('manual-1')
			const ownerCall = sdk.client.callTool({ name: 'owner.long', arguments: {} })
			await ownerEntered
			host.remove(Owner)
			let stopped = false
			const stopping = (async () => {
				await host.commit()
				stopped = true
			})()
			await Promise.resolve()
			expect(stopped).toBe(false)
			releaseOwner()
			expect(JSON.stringify(await ownerCall)).toContain('owner-1')
			await stopping
			const afterOwnerStop = await sdk.client.listTools()
			expect(afterOwnerStop.tools).toEqual([])
		} finally {
			releaseManual()
			releaseOwner()
			await sdk.client.close()
			await sdk.server.close()
			await host[Symbol.asyncDispose]()
		}
	})

	it('does not expose or invoke tools when authentication returns no principal', async () => {
		const sdk = fixture()
		let runs = 0
		const host = await createServiceInternalTestHarness({
			workbench: false,
			services: [mcp({ server: sdk.server, authenticate: () => undefined })],
		})
		try {
			host.ctx.require(Mcp).expose(
				defineCommand({
					name: 'auth.required',
					description: 'Requires an authenticated principal.',
					input: obj({}),
					execute: () => {
						runs++
						return Result.ok('completed')
					},
				}),
			)
			await Promise.all([
				sdk.server.connect(sdk.serverTransport),
				sdk.client.connect(sdk.clientTransport),
			])
			await expect(sdk.client.listTools()).rejects.toThrow('Tool discovery failed')
			const result = await sdk.client.callTool({ name: 'auth.required', arguments: {} })
			expect(result.isError).toBe(true)
			expect(runs).toBe(0)
		} finally {
			await sdk.client.close()
			await sdk.server.close()
			await host[Symbol.asyncDispose]()
		}
	})

	it('does not hold a publication owner open while host authentication waits', async () => {
		const sdk = fixture()
		let authenticationStarted!: () => void
		let releaseAuthentication!: () => void
		const entered = new Promise<void>((resolve) => {
			authenticationStarted = resolve
		})
		const authentication = new Promise<void>((resolve) => {
			releaseAuthentication = resolve
		})
		const host = await createServiceInternalTestHarness({
			workbench: false,
			services: [
				mcp({
					server: sdk.server,
					async authenticate() {
						authenticationStarted()
						await authentication
						return 'alice'
					},
				}),
			],
		})
		let stopping: Promise<unknown> | undefined
		let runs = 0
		try {
			@Plugin({ displayName: 'MCP authentication owner' })
			class Owner extends BasePlugin {
				override init() {
					this.ctx.require(Mcp).expose(
						defineCommand({
							name: 'auth.wait',
							description: 'Wait for host authentication.',
							input: obj({}),
							execute: () => {
								runs++
								return Result.ok('completed')
							},
						}),
					)
				}
			}
			lowerTestPlugin(Owner)
			host.add(Owner)
			host.cfg(Owner).setAutoStart(true)
			host.start(Owner)
			await host.commit()
			await Promise.all([
				sdk.server.connect(sdk.serverTransport),
				sdk.client.connect(sdk.clientTransport),
			])
			const call = sdk.client.callTool({ name: 'auth.wait', arguments: {} })
			await entered
			host.remove(Owner)
			stopping = host.commit()
			let timer: ReturnType<typeof setTimeout> | undefined
			const stoppedBeforeAuthentication = await Promise.race([
				stopping.then(() => true),
				new Promise<boolean>((resolve) => {
					timer = setTimeout(() => resolve(false), 1000)
				}),
			])
			if (timer) clearTimeout(timer)
			expect(stoppedBeforeAuthentication).toBe(true)
			releaseAuthentication()
			const result = await call
			expect(result.isError).toBe(true)
			expect(runs).toBe(0)
		} finally {
			releaseAuthentication()
			await stopping
			await sdk.client.close()
			await sdk.server.close()
			await host[Symbol.asyncDispose]()
		}
	})

	it('fails discovery as a whole and removes SDK handlers when the host closes', async () => {
		const sdk = fixture()
		const host = await createServiceInternalTestHarness({
			workbench: false,
			services: [mcp({ server: sdk.server, authenticate: () => 'alice' })],
		})
		let closed = false
		try {
			const mcpView = host.ctx.require(Mcp)
			mcpView.expose(
				defineCommand({
					name: 'visible.one',
					description: 'Visible before policy failure.',
					input: obj({}),
					execute: () => Result.ok('one'),
				}),
			)
			mcpView.expose(
				defineCommand({
					name: 'broken.policy',
					description: 'Policy fails.',
					input: obj({}),
					execute: () => Result.ok('two'),
				}),
				{
					authorize: () => {
						throw new Error('private policy failure')
					},
				},
			)
			await Promise.all([
				sdk.server.connect(sdk.serverTransport),
				sdk.client.connect(sdk.clientTransport),
			])
			await expect(sdk.client.listTools()).rejects.toThrow(/Tool discovery failed/)
			await expect(sdk.client.listTools()).rejects.not.toThrow(/private policy failure/)
			await host[Symbol.asyncDispose]()
			closed = true
			await expect(sdk.client.listTools()).rejects.toThrow(/not found/i)
		} finally {
			await sdk.client.close()
			await sdk.server.close()
			if (!closed) await host[Symbol.asyncDispose]()
		}
	})

	it('blocks calls withdrawn during context or authorization preparation', async () => {
		const sdk = fixture()
		const host = await createServiceInternalTestHarness({
			workbench: false,
			services: [mcp({ server: sdk.server, authenticate: () => ({ id: 'alice' }) })],
		})
		let registration!: { dispose(): void }
		let authorizationRegistration!: { dispose(): void }
		let began!: () => void
		let release!: () => void
		let authorizationBegan!: () => void
		let releaseAuthorization!: () => void
		const entered = new Promise<void>((resolve) => {
			began = resolve
		})
		const preparation = new Promise<void>((resolve) => {
			release = resolve
		})
		const authorizationEntered = new Promise<void>((resolve) => {
			authorizationBegan = resolve
		})
		const authorization = new Promise<void>((resolve) => {
			releaseAuthorization = resolve
		})
		let runs = 0
		try {
			@Plugin({ displayName: 'MCP preparation owner' })
			class Owner extends BasePlugin {
				override init() {
					registration = this.ctx.require(Mcp).expose(
						defineCommand({
							name: 'prepare.wait',
							description: 'Wait while constructing context.',
							input: obj({}),
							execute(_input, context: NoteContext) {
								runs++
								return Result.ok(context.actorId)
							},
						}),
						{
							async context() {
								began()
								await preparation
								return { actorId: 'alice' }
							},
						},
					)
					authorizationRegistration = this.ctx.require(Mcp).expose(
						defineCommand({
							name: 'authorize.wait',
							description: 'Wait while checking access.',
							input: obj({}),
							execute() {
								runs++
								return Result.ok('ran')
							},
						}),
						{
							async authorize() {
								authorizationBegan()
								await authorization
								return false
							},
						},
					)
				}
			}
			lowerTestPlugin(Owner)
			host.add(Owner)
			host.cfg(Owner).setAutoStart(true)
			host.start(Owner)
			await host.commit()
			await Promise.all([
				sdk.server.connect(sdk.serverTransport),
				sdk.client.connect(sdk.clientTransport),
			])
			const call = sdk.client.callTool({ name: 'prepare.wait', arguments: {} })
			await entered
			registration.dispose()
			release()
			const result = await call
			expect(result.isError).toBe(true)
			expect(JSON.stringify(result)).toContain('PUBLICATION_GONE')
			expect(runs).toBe(0)
			const authorizedCall = sdk.client.callTool({ name: 'authorize.wait', arguments: {} })
			await authorizationEntered
			authorizationRegistration.dispose()
			releaseAuthorization()
			const authorizedResult = await authorizedCall
			expect(authorizedResult.isError).toBe(true)
			expect(JSON.stringify(authorizedResult)).toContain('PUBLICATION_GONE')
			expect(runs).toBe(0)
		} finally {
			release()
			releaseAuthorization()
			await sdk.client.close()
			await sdk.server.close()
			await host[Symbol.asyncDispose]()
		}
	})
})
