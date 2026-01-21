// tests/normalizeValibot.test.ts

import { describe, expect, it } from 'bun:test'
import { normalizeSchemaSource } from '../src/utils/configHandler'

describe('normalizeSchemaSource', () => {
	const t = (name: string, input: string, expected: string) => {
		it(name, () => {
			const actual = normalizeSchemaSource(input)
			expect(actual).toBe(expected)
		})
	}

	// 1. optionalAsync 基本
	t('optionalAsync basic', 'v.optionalAsync(v.string(), async () => {})', 'v.optional(v.string())')

	// 2. optionalAsync + pipe
	t(
		'optionalAsync with pipe',
		'v.optionalAsync(v.pipe(v.string(),v.hexColor()), async () => {})',
		'v.optional(v.pipe(v.string(),v.hexColor()))',
	)

	// 3. pipe + transform
	t('pipe with transform', 'v.pipe(v.string(), v.transform((v)=>v.trim()))', 'v.string()')

	// 4. pipe + check
	t('pipe with check', 'v.pipe(v.string(), v.check((v)=>v.length>0))', 'v.string()')

	// 5. pipe 里既有 check 又有 transform
	t(
		'pipe with check + transform',
		'v.pipe(v.string(), v.check(v.string(), ()=>true), v.transform(v.number(), x=>x))',
		'v.string()',
	)

	// 6. pipeAsync 同样处理
	t(
		'pipeAsync with transform + checkAsync',
		'v.pipeAsync(v.string(), v.transform(v.number(), x=>x), v.checkAsync(()=>true))',
		'v.string()',
	)

	// 7. pipe 里嵌套 optionalAsync，再加 transform
	t(
		'pipe with nested optionalAsync',
		'v.pipe(v.optionalAsync(v.string(), async () => {}), v.transform((v)=>v))',
		'v.optional(v.string())',
	)

	// 8. object 里混合
	t(
		'object with optionalAsync + pipe + check',
		'v.object({a:v.optionalAsync(v.string(), async () => {}),b:v.pipe(v.string(),v.check(()=>true))})',
		'v.object({a:v.optional(v.string()),b:v.string()})',
	)

	// 9. strip TypeScript-only `as ...`
	t(
		'strip as const',
		"v.picklist(['compact','full'] as const)",
		"v.picklist(['compact','full'])",
	)
	t(
		'strip as type',
		'v.optional(v.string(), DEFAULT as string)',
		'v.optional(v.string(), DEFAULT)',
	)

	// 10. strip TypeScript-only `satisfies ...`
	t(
		'strip satisfies',
		'v.record(v.string(), v.any(), { a: 1 } satisfies Record<string, number>)',
		'v.record(v.string(), v.any(), { a: 1 })',
	)
})
