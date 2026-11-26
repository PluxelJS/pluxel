import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import { extractField, unionMeta } from '../core'

describe('union extraction', () => {
	it('infers discriminator and branches', () => {
		const schema = v.union([
			v.object({ type: v.literal('a'), value: v.string() }),
			v.object({ type: v.literal('b'), count: v.number() }),
		])
		const node = extractField(schema, { fieldName: 'config', path: 'config' })
		expect(node?.kind).toBe('union')
		if (node?.kind !== 'union') return
		expect(node.discriminator).toBe('type')
		expect(node.branches.length).toBe(2)
	})

	it('respects union metadata control', () => {
		const schema = v.pipe(
			v.union([
				v.object({ type: v.literal('a'), value: v.string() }),
				v.object({ type: v.literal('b'), count: v.number() }),
			]),
			unionMeta({ control: 'segmented' }),
			v.title('配置类型'),
		)
		const node = extractField(schema, { fieldName: 'config', path: 'config' })
		expect(node?.kind).toBe('union')
		if (node?.kind !== 'union') return
		expect(node.control).toBe('segmented')
		const labels = node.branches.map((b) => b.key)
		expect(labels.length).toBe(2)
	})

	it('uses the declared variant key and preserves raw value types when labels match', () => {
		const schema = v.variant('kind', [
			v.strictObject({ kind: v.literal(1), local: v.literal(true), path: v.string() }),
			v.strictObject({ kind: v.literal('1'), local: v.literal(false), topic: v.string() }),
		])
		const node = extractField(schema, { fieldName: 'destination' })
		expect(node.kind).toBe('union')
		if (node.kind !== 'union') throw new Error('Expected an editable union')
		expect(node.discriminator).toBe('kind')
		expect(node.branches.map(({ discriminatorValue }) => discriminatorValue)).toEqual([1, '1'])
		expect(new Set(node.branches.map(({ key }) => key)).size).toBe(2)
		expect(node.branches.map(({ fields }) => fields.map(({ key }) => key))).toEqual([
			['local', 'path'],
			['local', 'topic'],
		])
		expect(node.branches[0].fields[0].node.meta.readOnly).toBe(true)

		expect(() =>
			extractField(v.pipe(schema, unionMeta({ discriminator: 'local' })), {
				fieldName: 'destination',
			}),
		).toThrow(/destination\.unionMeta\.discriminator.*"kind"/)
	})

	it('provides a reason when one variant value can select multiple branches', () => {
		const schema = v.variant('kind', [
			v.strictObject({ kind: v.literal('same'), path: v.string() }),
			v.strictObject({ kind: v.picklist(['same', 'other']), topic: v.string() }),
		])
		expect(extractField(schema, { fieldName: 'destination' })).toMatchObject({
			name: 'destination',
			kind: 'unsupported',
			reason: 'Discriminator "kind" has ambiguous branch values',
			readOnly: true,
		})
	})

	it('rejects a plain union hint when the selector cannot write its key in every branch', () => {
		const schema = v.pipe(
			v.union([v.object({ type: v.literal('a') }), v.object({ type: v.string() })]),
			unionMeta({ discriminator: 'type' }),
		)
		expect(() => extractField(schema, { fieldName: 'destination' })).toThrow(
			/destination\.unionMeta\.discriminator must identify a finite input value for every branch/,
		)
	})
})
