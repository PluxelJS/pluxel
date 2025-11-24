import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import { unionMeta } from '~/core/actions/union'
import { extractUnionProps } from '~/core/actions/union/unionExtractor'

describe('extractUnionProps', () => {
	it('infers discriminator + switch variant for boolean variants', () => {
		const schema = v.pipe(
			v.variant('enabled', [
				v.object({ enabled: v.literal(false) }),
				v.object({ enabled: v.literal(true), config: v.string() }),
			]),
			unionMeta({}), // no explicit discriminator
		)

		const result = extractUnionProps(schema as any)
		expect(result.discriminator).toBe('enabled')
		expect(result.resolvedVariant).toBe('switch')
		expect(result.branches.map((b) => b.discriminatorValue)).toEqual([false, true])
		expect(result.discriminatorSchema?.type).toBe('literal')
	})

	it('fills missing discriminator values from branch labels', () => {
		const schema = v.pipe(
			v.union([
				v.object({ foo: v.string() }),
				v.object({ bar: v.number() }),
			]),
			unionMeta({
				discriminator: 'mode',
				branchLabels: { foo: 'Foo', bar: 'Bar' },
			}),
		)

		const result = extractUnionProps(schema as any)
		expect(result.branches.map((b) => b.discriminatorValue)).toEqual(['foo', 'bar'])
	})

	it('collects shared fields from intersect and preserves discriminator schema', () => {
		const schema = v.pipe(
			v.intersect([
				v.object({ enabled: v.boolean(), global: v.string() }),
				v.variant('enabled', [
					v.object({ enabled: v.literal(false) }),
					v.object({ enabled: v.literal(true), extra: v.number() }),
				]),
			]),
			unionMeta({ discriminator: 'enabled' }),
		)

		const result = extractUnionProps(schema as any)
		expect(result.discriminator).toBe('enabled')
		expect(result.discriminatorSchema?.type).toBe('boolean')
		expect(result.sharedFields.map((f) => f.key)).toContain('global')
	})

	it('falls back to boolean-ish values or indexes when discriminator values cannot be read', () => {
		const fakeUnion = {
			kind: 'schema',
			type: 'union',
			options: [
				{ kind: 'schema', type: 'object', entries: { foo: { kind: 'schema', type: 'string' } } },
				{ kind: 'schema', type: 'object', entries: { bar: { kind: 'schema', type: 'string' } } },
			],
			pipe: [unionMeta({ discriminator: 'mode' })],
		}

		const result = extractUnionProps(fakeUnion as any)
		expect(result.branches.map((b) => b.discriminatorValue)).toEqual([false, true])
		expect(result.resolvedVariant).toBe('switch')
	})
})
