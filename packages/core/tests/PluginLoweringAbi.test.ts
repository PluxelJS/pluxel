import { describe, expect, it } from 'vitest'
import { BasePlugin } from '../src/plugins/composition/BasePlugin'
import { Plugin } from '../src/plugins/decorators/decorator/decorators'
import { checkPluginDecorator } from '../src/plugins/decorators/decorator/api'
import {
	pluginDefinitionAddressOf,
	pluginNodeAddressOf,
	type PluginDefinitionLoweringPayload,
} from '../src/plugins/runtime/definition'
import { consumePluginDefinitionCandidate } from '../src/internal'
import { createCoreHost } from '../src/test'
import {
	__setPluginConfig,
	__setPluginDefinition,
	__setPluginPartConfig,
	__setPluginPartOptional,
	__setPluginParts,
	PLUGIN_LOWERING_ABI_VERSION,
	PluginLoweringError,
} from '../src/toolchain'

const objectSchema = Object.freeze({
	'~standard': Object.freeze({
		version: 1 as const,
		vendor: 'pluxel:test',
		validate: (value: unknown) => ({ value: value ?? {} }),
	}),
})

function address(exportName: string) {
	return {
		entry: { kind: 'source-entry' as const, sourceSpace: 'app', path: 'plugin.ts' },
		exportName,
	}
}

function captureLoweringError(action: () => unknown): PluginLoweringError {
	try {
		action()
	} catch (error) {
		if (error instanceof PluginLoweringError) return error
		throw error
	}
	throw new Error('Expected PluginLoweringError')
}

describe('Plugin lowering ABI v1', () => {
	it('ingests one immutable candidate with forkability and a definition-local Part tree', () => {
		abstract class CacheToken extends BasePlugin {}
		class CachePart {}
		class CachePlugin extends CacheToken {}
		Plugin(CacheToken, { displayName: 'Cache', forkable: true })(CachePlugin)

		__setPluginDefinition(CacheToken, {
			abiVersion: PLUGIN_LOWERING_ABI_VERSION,
			kind: 'abstract',
			definition: address('CacheToken'),
		})
		__setPluginDefinition(CachePlugin, {
			abiVersion: PLUGIN_LOWERING_ABI_VERSION,
			kind: 'plugin',
			definition: address('CachePlugin'),
			optional: [address('DirectOptional')],
			provides: address('CacheToken'),
		})
		__setPluginParts(CachePlugin, {
			abiVersion: PLUGIN_LOWERING_ABI_VERSION,
			occurrences: [{ fieldName: 'cache', Part: CachePart }],
		})
		__setPluginPartConfig(CachePart, {
			abiVersion: PLUGIN_LOWERING_ABI_VERSION,
			fieldName: 'config',
			schema: objectSchema,
		})
		__setPluginPartOptional(CachePart, {
			abiVersion: PLUGIN_LOWERING_ABI_VERSION,
			optional: [address('PartOptional')],
		})
		__setPluginConfig(CachePlugin, {
			abiVersion: PLUGIN_LOWERING_ABI_VERSION,
			fieldName: 'config',
			schema: objectSchema,
		})

		expect(checkPluginDecorator(CachePlugin)).toBe(true)
		const candidate = consumePluginDefinitionCandidate(CachePlugin)

		expect(candidate.implementation).toBe(CachePlugin)
		expect(candidate.declaration).toMatchObject({
			displayName: 'Cache',
			forkable: true,
			provides: address('CacheToken'),
		})
		expect(candidate.declaration.optional.map((item) => item.exportName)).toEqual([
			'DirectOptional',
			'PartOptional',
		])
		expect(candidate.declaration.parts[0]).toMatchObject({
			fieldName: 'cache',
			Part: CachePart,
			config: { fieldName: 'config' },
		})
		expect(Object.isFrozen(candidate)).toBe(true)
		expect(Object.isFrozen(candidate.declaration)).toBe(true)
		expect(Object.isFrozen(candidate.declaration.parts)).toBe(true)
		expect(Object.isFrozen(candidate.declaration.parts[0])).toBe(true)
		expect(pluginDefinitionAddressOf(CacheToken)).toEqual(address('CacheToken'))
		expect(pluginNodeAddressOf(CachePlugin)).toMatchObject({ variant: 'default' })
		expect(checkPluginDecorator(CachePlugin)).toBe(true)

		expect(consumePluginDefinitionCandidate(CachePlugin)).toBe(candidate)
		expect(
			captureLoweringError(() =>
				__setPluginConfig(CachePlugin, {
					abiVersion: PLUGIN_LOWERING_ABI_VERSION,
					fieldName: 'late',
					schema: objectSchema,
				}),
			).code,
		).toBe('plugin_declaration_invalid')
	})

	it('exposes stable unsupported, missing, and invalid codes', () => {
		class Unsupported extends BasePlugin {}
		expect(
			captureLoweringError(() =>
				__setPluginDefinition(Unsupported, {
					abiVersion: 2,
					kind: 'plugin',
					definition: address('Unsupported'),
				} as unknown as PluginDefinitionLoweringPayload),
			).code,
		).toBe('plugin_lowering_abi_unsupported')

		class Missing extends BasePlugin {}
		expect(captureLoweringError(() => consumePluginDefinitionCandidate(Missing)).code).toBe(
			'plugin_declaration_missing',
		)

		class Invalid extends BasePlugin {}
		expect(
			captureLoweringError(() =>
				__setPluginDefinition(Invalid, {
					abiVersion: PLUGIN_LOWERING_ABI_VERSION,
					kind: 'plugin',
					definition: address('Invalid'),
					unknown: true,
				} as unknown as PluginDefinitionLoweringPayload),
			).code,
		).toBe('plugin_declaration_invalid')
	})

	it('seals reusable Part facts without a process-wide revision or clone path', () => {
		class SharedPart {}
		class FirstPlugin extends BasePlugin {}
		class SecondPlugin extends BasePlugin {}
		Plugin()(FirstPlugin)
		Plugin()(SecondPlugin)
		for (const [PluginClass, exportName] of [
			[FirstPlugin, 'FirstPlugin'],
			[SecondPlugin, 'SecondPlugin'],
		] as const) {
			__setPluginDefinition(PluginClass, {
				abiVersion: PLUGIN_LOWERING_ABI_VERSION,
				kind: 'plugin',
				definition: address(exportName),
			})
			__setPluginParts(PluginClass, {
				abiVersion: PLUGIN_LOWERING_ABI_VERSION,
				occurrences: [{ fieldName: 'shared', Part: SharedPart }],
			})
		}
		__setPluginPartConfig(SharedPart, {
			abiVersion: PLUGIN_LOWERING_ABI_VERSION,
			fieldName: 'config',
			schema: objectSchema,
		})

		const first = consumePluginDefinitionCandidate(FirstPlugin)
		const second = consumePluginDefinitionCandidate(SecondPlugin)

		expect(first.declaration.parts[0]?.config).toBe(second.declaration.parts[0]?.config)
		expect(
			captureLoweringError(() =>
				__setPluginPartOptional(SharedPart, {
					abiVersion: PLUGIN_LOWERING_ABI_VERSION,
					optional: [],
				}),
			).code,
		).toBe('plugin_declaration_invalid')
	})

	it('rejects non-true runtime forkability values', () => {
		expect(() => Plugin({ forkable: false } as never)).toThrow('literal true')
	})

	it('reuses one lowered candidate identity across independent hosts and node variants', async () => {
		class CrossHostPlugin extends BasePlugin {}
		Plugin({ forkable: true })(CrossHostPlugin)
		__setPluginDefinition(CrossHostPlugin, {
			abiVersion: PLUGIN_LOWERING_ABI_VERSION,
			kind: 'plugin',
			definition: address('CrossHostPlugin'),
		})
		const candidate = consumePluginDefinitionCandidate(CrossHostPlugin)
		const first = createCoreHost()
		const second = createCoreHost()
		try {
			const fork = first.fork(CrossHostPlugin, 'isolated')
			first.add(CrossHostPlugin)
			second.add(CrossHostPlugin)
			await Promise.all([first.commit(), second.commit()])

			expect(consumePluginDefinitionCandidate(CrossHostPlugin)).toBe(candidate)
			expect(first.require(CrossHostPlugin).constructor).toBe(CrossHostPlugin)
			expect(first.require(fork).constructor).toBe(CrossHostPlugin)
			expect(second.require(CrossHostPlugin).constructor).toBe(CrossHostPlugin)
		} finally {
			await Promise.all([first.dispose(), second.dispose()])
		}
	})
})
