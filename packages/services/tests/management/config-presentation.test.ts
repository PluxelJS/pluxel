import { BasePlugin, Plugin, PluginPart } from '@pluxel/core'
import { createHost } from '@pluxel/host'
import { RpcStub, serialize } from 'capnweb'
import { expect, test, vi } from 'vitest'
import { arrayMeta, extractFormFields, numberMeta, picklistMeta } from 'valibot-form'
import * as v from 'valibot'
import { managementAccess } from '../../src/management/access'
import { createRuntimeManagementClient } from '../../src/management/client'
import { createHostManagementTarget, management } from '../../src/management/service'
import { compileConfigPresentationPlanV3 } from '../../src/management/api/presenters/configPresentation'
import { parseConfigPresentationPlanV3 } from '../../src/management/web/validation'

const Connections = v.object({
	connections: v.optional(
		v.array(v.pipe(v.string(), v.minLength(1, 'Connection name must not be empty'))),
		[],
	),
	labels: v.optional(
		v.record(v.string(), v.pipe(v.string(), v.minLength(1, 'Label must not be empty'))),
		{},
	),
})

class ConnectionPart extends PluginPart<ConnectionPair> {
	readonly config = this.configs.use(Connections)
}

@Plugin()
class ConnectionPair extends BasePlugin {
	readonly east = this.parts.use(ConnectionPart)
	readonly west = this.parts.use(ConnectionPart)
}

test('transports each original Part-only declaration and preserves typed issue paths', async () => {
	await using host = await createHost({
		plugins: [{ plugin: ConnectionPair }],
		services: [managementAccess(), management()],
		config: { document: false },
		policy: { document: false },
	})
	await host.start()
	using remote = new RpcStub(createHostManagementTarget(host.ctx))
	const client = createRuntimeManagementClient(remote)

	const owner = ConnectionPair.nodeAddress()
	expect(await client.config.presentation(owner)).toEqual({
		ok: true,
		plan: {
			version: 3,
			sections: ['east', 'west'].map((name) => ({
				path: [name],
				fieldName: 'config',
				fields: extractFormFields(Connections),
			})),
		},
	})
	const validation = await client.config.validate(owner, {
		set: { east: { connections: ['east'] }, west: { connections: [''], labels: { '0': '' } } },
	})
	expect(validation).toMatchObject({
		ok: false,
		code: 'validation_failed',
		errors: {
			_root: {
				west: [
					{ path: ['west', 'connections', 0], message: 'Connection name must not be empty' },
					{ path: ['west', 'labels', '0'], message: 'Label must not be empty' },
				],
			},
		},
	})
	if (validation.ok !== false || validation.code !== 'validation_failed')
		throw new Error('Expected validation errors')
	expect(Object.keys(validation.errors._root!)).toEqual(['west'])
})

test('roundtrips the common field tree and keeps numeric formatting and explicit collection seeds', () => {
	const transform = vi.fn((value: number) => value * 10)
	const schema = v.strictObject({
		role: v.pipe(
			v.picklist(['reader', 'editor']),
			picklistMeta({ labels: { reader: 'Reader', editor: undefined }, searchable: false }),
		),
		price: v.pipe(
			v.number(),
			numberMeta({ format: { style: 'currency', currency: 'TWD', maximumFractionDigits: 0 } }),
			v.transform(transform),
			v.minValue(10),
		),
		choices: v.pipe(v.array(v.nullable(v.string())), arrayMeta({ defaultItem: null })),
		intervals: v.pipe(v.array(v.number()), arrayMeta({ defaultItem: 0 })),
	})
	const fields = extractFormFields(schema)
	const plan = compileConfigPresentationPlanV3([{ path: [], fieldName: 'config', schema }])
	expect(plan.sections[0]?.fields).toEqual(fields)
	expect(parseConfigPresentationPlanV3(JSON.parse(JSON.stringify(plan)))).toEqual(plan)
	expect(() => serialize(plan)).not.toThrow()
	expect(fields).toMatchObject([
		{ kind: 'picklist', labels: { reader: 'Reader' }, searchable: false },
		{ kind: 'number', format: { style: 'currency', currency: 'TWD', maximumFractionDigits: 0 } },
		{ kind: 'array', defaultItem: null, item: { nullable: true } },
		{ kind: 'array', defaultItem: 0 },
	])
	expect(fields[1]).not.toHaveProperty('min')
	expect(transform).not.toHaveBeenCalled()
	expect(v.parse(schema, { role: 'reader', price: 1, choices: [], intervals: [] }).price).toBe(10)
})

test('keeps an empty section and shows opaque declarations and seeds as read-only', () => {
	const schema = v.object({
		items: v.pipe(v.array(v.string()), arrayMeta({ defaultItem: () => 'not portable' })),
	})
	const plan = compileConfigPresentationPlanV3([
		{ path: [], fieldName: 'config', schema: v.strictObject({}) },
		{ path: ['seed'], fieldName: 'config', schema },
		{
			path: ['opaque'],
			fieldName: 'vendorConfig',
			schema: { '~standard': { version: 1, vendor: 'fixture', validate: vi.fn() } },
		},
	])
	expect(plan.sections.map((section) => section.fields.map((field) => field.kind))).toEqual([
		[],
		['unsupported'],
		['unsupported'],
	])
	expect(plan.sections[1]?.fields[0]).toMatchObject({
		name: 'items',
		readOnly: true,
		meta: { readOnly: true },
		reason: expect.stringContaining('defaultItem'),
	})
	expect(plan.sections[2]?.fields[0]).toMatchObject({ name: 'vendorConfig', readOnly: true })
	expect(JSON.stringify(plan)).not.toContain('validate')
})
