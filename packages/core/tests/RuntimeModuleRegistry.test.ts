import { describe, expect, it } from 'vitest'

import { BasePlugin, Plugin } from '@pluxel/core/test'
import { RuntimeModuleRegistry } from '../src/plugins/runtime/plugin-service/RuntimeModuleRegistry'

describe('RuntimeModuleRegistry', () => {
	it('clears duplicate same-name ctor ownership when a module is removed', () => {
		@Plugin({ name: 'RUNTIME-MODULE-DUPLICATE' })
		class First extends BasePlugin {}

		@Plugin({ name: 'RUNTIME-MODULE-DUPLICATE' })
		class Second extends BasePlugin {}

		const registry = new RuntimeModuleRegistry()
		registry.upsert({
			moduleId: 'duplicate.ts',
			items: [
				{ ctor: First, exportKey: 'First' },
				{ ctor: Second, exportKey: 'Second' },
			],
		})

		expect(registry.ctorForName('RUNTIME-MODULE-DUPLICATE')).toBe(Second)

		registry.remove('duplicate.ts')

		expect(registry.ctorForName('RUNTIME-MODULE-DUPLICATE')).toBeUndefined()
	})
})
