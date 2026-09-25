import { defineCommand, Result, type CommandContext } from '@pluxel/commands'
import { obj, Type } from '@pluxel/commands/typebox'
import { BasePlugin, Plugin } from '@pluxel/core'
import {
	__setPluginDefinition,
	__setPluginRpcSites,
	PLUGIN_LOWERING_ABI_VERSION,
} from '@pluxel/core/toolchain'
import { createHost } from '@pluxel/host'
import { Rpc, rpc, type RpcPublication, type RpcService } from '@pluxel/services/rpc'
import { expect, it } from 'vitest'
import type { RpcArtifact } from '../../src/rpc/kernel'

const definition = {
	entry: { kind: 'package-root', packageName: '@test/rpc-service' },
	exportName: 'Owner',
} as const

interface ActorContext extends CommandContext {
	actorId: string
}

function publicationTypeChecks(view: RpcService) {
	const read = defineCommand({
		name: 'types.read',
		description: 'Read with an actor.',
		input: obj({}),
		execute(_input, context: ActorContext) {
			return Result.ok(context.actorId)
		},
	})
	// @ts-expect-error A required business context needs a factory.
	view.publish({ id: 'types', commands: { read } })
	const invalid = { actorId: 'alice', signal: new AbortController().signal }
	// @ts-expect-error A predeclared factory result cannot replace the carrier signal.
	view.publish({ id: 'types', commands: { read }, context: () => invalid })
	view.publish({ id: 'types', commands: { read }, context: () => ({ actorId: 'alice' }) })
}
void publicationTypeChecks

function build(label: string, calls: string[]) {
	const command = defineCommand({
		name: 'notes.read',
		description: 'Read a note.',
		input: obj({ id: Type.String() }),
		execute({ id }) {
			calls.push(`${label}:${id}`)
			return Result.ok({ id, label })
		},
	})
	const bindings = Object.freeze({ read: command })
	const artifact: RpcArtifact = Object.freeze({
		format: 'pluxel-rpc-artifact-v1',
		integrity: 'a'.repeat(64),
		contract: Object.freeze({ id: 'notes', hash: 'b'.repeat(64) }),
		methods: Object.freeze([
			Object.freeze({
				method: 'read',
				command: command.name,
				description: command.descriptor.description,
				inputSchema: command.descriptor.inputSchema,
			}),
		]),
		types: Object.freeze([
			Object.freeze({
				method: 'read',
				input: '{ id: string }',
				success: '{ id: string; label: string }',
			}),
		]),
		declaration:
			'export interface NotesApi { read(input: { id: string }): Promise<RpcResult<{ id: string; label: string }>> }',
	})
	let publication: RpcPublication | undefined
	@Plugin()
	class Owner extends BasePlugin {
		override init() {
			publication = this.ctx.require(Rpc).publish({
				api: { id: 'notes', commands: { read: command } },
				bindings,
				artifact,
			} as never)
		}
	}
	__setPluginDefinition(Owner, {
		abiVersion: PLUGIN_LOWERING_ABI_VERSION,
		kind: 'plugin',
		definition,
	})
	__setPluginRpcSites(Owner, {
		abiVersion: PLUGIN_LOWERING_ABI_VERSION,
		sites: Object.freeze([
			Object.freeze({ site: `${label}:notes`, owner: 'Owner', artifact, bindings }),
		]),
	})
	return {
		Owner,
		artifact,
		bindings,
		get publication() {
			return publication
		},
	}
}

it('binds a generated publication to its exact Host candidate and current generation', async () => {
	const calls: string[] = []
	const first = build('first', calls)
	const second = build('second', calls)
	const host = await createHost({
		plugins: [first.Owner],
		services: [rpc()],
		state: { initial: { autoStart: [{ definition, variant: 'default' }] } },
	})
	try {
		await host.start()
		const root = host.ctx.require(Rpc)
		expect('prepareTrustedSites' in root).toBe(false)
		expect('kernel' in root).toBe(false)
		const firstPublication = first.publication!
		const oldSession = root.createSession({
			principal: { id: 'alice' },
			access: [firstPublication.contract],
		})
		const firstCall = await oldSession.call({ id: 'notes', method: 'read', input: { id: 'one' } })
		expect(firstCall).toMatchObject({ ok: true, value: { id: 'one', label: 'first' } })
		await host.updateCatalog([second.Owner])
		const gone = await oldSession.call({ id: 'notes', method: 'read', input: { id: 'two' } })
		expect(gone).toMatchObject({ ok: false, error: { code: 'PUBLICATION_GONE' } })
		const fresh = root.createSession({
			principal: { id: 'alice' },
			access: [second.publication!.contract],
		})
		const secondCall = await fresh.call({ id: 'notes', method: 'read', input: { id: 'three' } })
		expect(secondCall).toMatchObject({ ok: true, value: { id: 'three', label: 'second' } })
		expect(calls).toEqual(['first:one', 'second:three'])
		await Promise.all([oldSession.close(), fresh.close()])
	} finally {
		await host.close()
	}
})
