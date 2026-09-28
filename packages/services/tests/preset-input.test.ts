import { expect, test } from 'vitest'
import type { HostStartupContext } from '@pluxel/host'
import { servicesPreset } from '../src/preset'

const startup: HostStartupContext = { root: process.cwd(), mode: 'test', env: {}, bindings: {} }

test('preset rejects unknown and invalid options before loading services', async () => {
	await expect(
		servicesPreset(startup, { persistence: { mode: 'memory' }, workbench: 'false' } as never),
	).rejects.toThrow('options.workbench must be a boolean')
	await expect(
		servicesPreset(startup, { persistence: { mode: 'memory' }, workbech: false } as never),
	).rejects.toThrow('Unknown option options.workbech')
})
