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
})
