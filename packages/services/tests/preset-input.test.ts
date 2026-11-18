import { expect, test } from 'vitest'
import { createHost, type HostStartupContext } from '@pluxel/host'
import { servicesPreset } from '../src/preset'
import { Commands } from '../src/commands'
import { ElysiaRuntime } from '../src/elysia/runtime'
import { Management } from '../src/management/service'

const startup: HostStartupContext = { root: process.cwd(), mode: 'test', env: {}, bindings: {} }

test('preset rejects unknown and invalid options before loading services', async () => {
	await expect(servicesPreset(startup, { workbench: 'false' } as never)).rejects.toThrow(
		'options.workbench must be an object',
	)
	await expect(servicesPreset(startup, { workbech: false } as never)).rejects.toThrow(
		'Unknown option options.workbech',
	)
})

test.each([
	['nodeModules.root', { nodeModules: { root: '/' } }],
	['management.application', { management: { application: {} } }],
	['management.workbench', { management: { workbench: false } }],
	['managementHttp.bindings', { managementHttp: { bindings: () => ({}) } }],
	['workbench.service.product', { workbench: { service: { product: {} } } }],
	['workbench.service.artifacts', { workbench: { service: { artifacts: {} } } }],
	['workbench.http.publicDir', { workbench: { http: { publicDir: '/' } } }],
])('preset claims only its wiring fields (%s)', async (field, options) => {
	await expect(servicesPreset(startup, options as never)).rejects.toThrow(
		`options.${field} is owned by the preset`,
	)
})

test('headless deployment reports an attempted Workbench installation', async () => {
	await expect(
		servicesPreset({
			...startup,
			deployment: {
				root: startup.root,
				target: 'node',
				delivery: 'standalone',
				variant: 'headless',
			},
		}),
	).rejects.toThrow('Workbench requires a deployment with Workbench artifacts')
})

test.each(['logging', 'loggingOptions', 'vault'])(
	'preset rejects removed Core capability option %s',
	async (key) => {
		await expect(servicesPreset(startup, { [key]: {} } as never)).rejects.toThrow(
			`Unknown option options.${key}`,
		)
	},
)

test('headless preset retains Management and commands without Workbench services', async () => {
	const services = await servicesPreset(startup, { workbench: false })
	expect(services.map((service) => service.name)).toEqual(
		expect.arrayContaining(['Management', 'ManagementHTTP', 'Management commands']),
	)
	expect(services.some((service) => /Workbench|Vault/.test(service.name))).toBe(false)
	await using host = await createHost({ plugins: [], services })
	expect(host.ctx.service(Management).describe().workbench.enabled).toBe(false)
	expect(host.ctx.service(Commands).list().length).toBeGreaterThan(0)
	const response = await host.ctx
		.service(ElysiaRuntime)
		.fetch(new Request('http://local.test/__pluxel/workbench'))
	expect(response.status).toBe(404)
	await response.body?.cancel()
})
