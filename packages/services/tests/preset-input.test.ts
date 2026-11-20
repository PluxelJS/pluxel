import { expect, test } from 'vitest'
import type { HostStartupContext } from '@pluxel/host'
import { servicesPreset } from '../src/preset'

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
