import { InMemory } from '@pluxel/services/fs'
import { expect, test } from 'vitest'
import type { HostStartupContext } from '@pluxel/host'
import { servicesPreset } from '../src/preset'

const startup: HostStartupContext = { root: process.cwd(), mode: 'test', env: {}, bindings: {} }

test('preset rejects unknown and invalid options before loading services', async () => {
	await expect(
		servicesPreset(startup, { fs: { backend: InMemory }, workbench: 'false' } as never),
	).rejects.toThrow('options.workbench must be a boolean')
	await expect(
		servicesPreset(startup, { fs: { backend: InMemory }, workbech: false } as never),
	).rejects.toThrow('Unknown option options.workbech')
})
