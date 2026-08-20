import { defineCommand } from '@pluxel/commands'
import { obj, Type } from '@pluxel/commands/typebox'
import { getPluginConfigDefinition, pluginNodeAddressOf } from '@pluxel/core'
import { PLUGIN_HTTP_BASE } from '@pluxel/runtime'
import { BasePlugin, Plugin, PluginPart, withRuntimeHost } from '@pluxel/runtime/test'
import { workbench } from '@pluxel/runtime/workbench'
import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import { pluginNodePhysicalKey } from '../../src/runtime/plugin-address'
import { pluginSchema } from '../../src/api/usecases/pluginConfig'

const extension = workbench.extension({ contract: workbenchContract.define({}) })
let partCommands: unknown
let repeatedPartCommands: unknown
let ownerCommands: unknown
let workbenchError: unknown

class CapabilityPart extends PluginPart<CapabilityOwner> {
	override init() {
		partCommands = this.ctx.commands
		repeatedPartCommands = this.ctx.commands
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
		this.ctx.http.plugin.routes((app) => app.get('/', () => 'part-route'))
		try {
			this.ctx.workbench.mount(extension, {})
		} catch (error) {
			workbenchError = error
		}
	}
}

@Plugin({ displayName: 'PluginPart capability owner' })
class CapabilityOwner extends BasePlugin {
	readonly capability = this.parts.use(CapabilityPart)

	override init() {
		ownerCommands = this.ctx.commands
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
		workbenchError = undefined

		await withRuntimeHost(
			async (host) => {
				await host.start(CapabilityOwner)
				const ownerKey = pluginNodePhysicalKey(pluginNodeAddressOf(CapabilityOwner))

				expect(partCommands).toBe(repeatedPartCommands)
				expect(partCommands).not.toBe(ownerCommands)
				expect(workbenchError).toMatchObject({
					message: expect.stringContaining('PluginPart cannot mount'),
				})
				await expect(host.ctx.commands.executeOrThrow('part.capability.read', {})).resolves.toEqual(
					{ value: 'part' },
				)

				const mounted = await host.ctx.http.fetch(
					new Request(`http://local${PLUGIN_HTTP_BASE}/${ownerKey}`),
				)
				expect(await mounted.text()).toBe('part-route')

				host.remove(CapabilityOwner)
				await host.commit()
				expect(host.ctx.commands.get('part.capability.read')).toBeUndefined()
				const removed = await host.ctx.http.fetch(
					new Request(`http://local${PLUGIN_HTTP_BASE}/${ownerKey}`),
				)
				expect(removed.status).toBe(404)
			},
			{ workbench: false },
		)
	})

	it('projects owner and Part schemas as Workbench sections under one config owner', async () => {
		await withRuntimeHost(
			async (host) => {
				await host.start(ConfiguredOwner)
				const definition = getPluginConfigDefinition(ConfiguredOwner)
				expect(definition).toMatchObject({
					owner: { fieldName: 'config' },
					parts: [{ path: ['configured'], declaration: { fieldName: 'config' } }],
				})
				expect(definition?.owner?.source).toContain('v.object')
				expect(definition?.parts[0]?.declaration?.source).toContain('v.object')
				host.ctx.runtimeRoute = {
					catalog: {} as never,
					configMetadata: { getConfig: () => definition },
				}
				await expect(
					pluginSchema(host.ctx, pluginNodeAddressOf(ConfiguredOwner)),
				).resolves.toMatchObject({
					ok: true,
					defaults: { enabled: true, configured: { size: 10 } },
					sections: [
						{ path: [], defaults: { enabled: true } },
						{ path: ['configured'], defaults: { size: 10 } },
					],
				})
			},
			{ workbench: false },
		)
	})
})
