import { defineCommand } from '@pluxel/commands'
import { obj, Type } from '@pluxel/commands/typebox'
import { pluginDefinitionIndexKey, pluginNodeAddressOf } from '@pluxel/core'
import { createRuntimeInternalTestHost } from '@pluxel/runtime/internal/test'
import { BasePlugin, Plugin, PluginPart } from '@pluxel/runtime/test'
import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import { Elysia } from 'elysia'
import { pluginConfigPresentation } from '../../src/api/usecases/pluginConfig'
import { requireRuntimePluginGraphCoordinator } from '../../src/internal/reconciliation'

let partCommands: unknown
let repeatedPartCommands: unknown
let ownerCommands: unknown
let partElysia: unknown
let repeatedPartElysia: unknown
let ownerElysia: unknown

class CapabilityPart extends PluginPart<CapabilityOwner> {
	protected override init() {
		partCommands = this.ctx.commands
		repeatedPartCommands = this.ctx.commands
		partElysia = this.ctx.elysia
		repeatedPartElysia = this.ctx.elysia
		this.ctx.commands.register(
			defineCommand({
				name: 'part.capability.read',
				description: 'Read a value registered by a PluginPart.',
				behavior: { kind: 'query', world: 'closed' },
				input: obj({}),
				output: obj({ value: Type.String() }),
				execute: () => ({ value: 'part' }),
			}),
		)
		this.ctx.elysia.get('/part-capability', () => 'part-route')
	}
}

@Plugin({ displayName: 'PluginPart capability owner' })
class CapabilityOwner extends BasePlugin {
	readonly capability = this.parts.use(CapabilityPart)

	override init() {
		ownerCommands = this.ctx.commands
		ownerElysia = this.ctx.elysia
	}
}

const PartConfig = v.object({ size: v.optional(v.number(), 10) })
const OwnerConfig = v.object({ enabled: v.optional(v.boolean(), true) })

class ConfiguredPart extends PluginPart<ConfiguredOwner> {
	readonly config = this.configs.use(PartConfig)
}

@Plugin({ displayName: 'Configured PluginPart owner' })
class ConfiguredOwner extends BasePlugin {
	readonly configured = this.parts.use(ConfiguredPart)
	readonly config = this.configs.use(OwnerConfig)
}

describe('PluginPart runtime capabilities', () => {
	it('binds lightweight owner views, shares backends and revokes Part resources with the Plugin', async () => {
		partCommands = undefined
		repeatedPartCommands = undefined
		ownerCommands = undefined
		partElysia = undefined
		repeatedPartElysia = undefined
		ownerElysia = undefined

		{
			await using host = createRuntimeInternalTestHost({ workbench: { enabled: true } })

			await host.start(CapabilityOwner)
			expect(partCommands).toBe(repeatedPartCommands)
			expect(partCommands).not.toBe(ownerCommands)
			expect(partElysia).toBe(repeatedPartElysia)
			expect(partElysia).toBe(ownerElysia)
			expect(partElysia).toBeInstanceOf(Elysia)
			expect(() => {
				;(partCommands as { ctx: unknown }).ctx = host.ctx
			}).toThrow(TypeError)
			await expect(host.commands.execute('part.capability.read', {})).resolves.toEqual({
				value: 'part',
			})

			const mounted = await host.http.fetch(new Request('http://local/part-capability'))
			expect(await mounted.text()).toBe('part-route')

			await host.commit((change) => change.catalog.remove(CapabilityOwner))
			expect(host.commands.list().some(({ name }) => name === 'part.capability.read')).toBe(
				false,
			)
			const removed = await host.http.fetch(new Request('http://local/part-capability'))
			expect(removed.status).toBe(404)
		}
	})

	it('projects owner and Part schemas as Workbench sections under one config owner', async () => {
		{
			await using host = createRuntimeInternalTestHost({ workbench: false })

			await host.start(ConfiguredOwner)
			const address = pluginNodeAddressOf(ConfiguredOwner)
			const definition = requireRuntimePluginGraphCoordinator(host.ctx)
				.catalogSnapshot()
				.byDefinition.get(pluginDefinitionIndexKey(address.definition))?.candidate
				.declaration.config
			expect(definition).toMatchObject({
				owner: { fieldName: 'config' },
				parts: [{ path: ['configured'], declaration: { fieldName: 'config' } }],
			})
			expect(definition?.owner?.source).toContain('v.object')
			expect(definition?.parts[0]?.declaration?.source).toContain('v.object')
			await expect(pluginConfigPresentation(host.ctx, address)).resolves.toMatchObject({
				ok: true,
				plan: {
					defaults: { enabled: true, configured: { size: 10 } },
					sections: [
						{ path: [], defaults: { enabled: true } },
						{ path: ['configured'], defaults: { size: 10 } },
					],
				},
			})
		}
	})
})
