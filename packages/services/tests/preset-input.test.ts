import { expect, test } from 'vitest'
import { type HostStartupContext } from '@pluxel/host'
import { servicesPreset } from '../src/preset'

const startup: HostStartupContext = { root: process.cwd(), mode: 'test', env: {}, bindings: {} }

test('preset rejects unknown and invalid options before loading services', async () => {
	await expect(servicesPreset(startup, { workbench: 'false' } as never)).rejects.toThrow(
		'options.workbench must be a boolean',
	)
	await expect(servicesPreset(startup, { workbech: false } as never)).rejects.toThrow(
		'Unknown option options.workbech',
	)
})

test.each(['logging', 'loggingOptions'])(
	'preset rejects removed option %s; logging belongs to Core config',
	async (key) => {
		await expect(servicesPreset(startup, { [key]: {} } as never)).rejects.toThrow(
			`Unknown option options.${key}`,
		)
	},
)
