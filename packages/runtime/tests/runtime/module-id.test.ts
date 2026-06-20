import { describe, expect, it } from 'vitest'

import { findRuntimeModuleId } from '../../src/runtime/module-id'

describe('runtime module id lookup', () => {
	it('prefers core runtime ownership before loader registry fallback', () => {
		const ctx = {
			registry: {
				getRuntimeModuleId: (name: string) => (name === 'PluginA' ? '/core/PluginA.ts' : undefined),
			},
			loader: {
				api: {
					registry: {
						findModuleIdByName: (name: string) => `/loader/${name}.ts`,
					},
				},
			},
		}

		expect(findRuntimeModuleId(ctx, 'PluginA')).toBe('/core/PluginA.ts')
		expect(findRuntimeModuleId(ctx, 'PluginB')).toBe('/loader/PluginB.ts')
		expect(findRuntimeModuleId(ctx, '   ')).toBeNull()
	})
})
