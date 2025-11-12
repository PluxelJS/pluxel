import { formOptions } from '@tanstack/react-form'
import type { ObjectSchema } from 'valibot'
import * as v from 'valibot'
import * as f from '~/core/index'
import * as schema from './schema'

export interface AutoFormCase {
	id: string
	label: string
	description?: string
	schema: ObjectSchema<any, any>
	formOpts?: ReturnType<typeof formOptions<any>>
}

const UserSchema = v.object({
	id: v.pipe(
		v.number(),
		f.numberMeta({
			type: 'slider',
			options: {
				min: 0,
				max: 100,
				step: 5,
				marks: [
					{ value: 0, label: '0' },
					{ value: 5, label: '5' },
					{ value: 10, label: '10' },
				],
			},
		}),
		v.maxValue(10), // UI 允许到 100，但校验限制为 ≤10
	),
	color: v.optional(v.pipe(v.string(), v.hexColor()), '#000000'),
	name: v.optional(v.pipe(v.string(), v.minLength(2)), 'a'),
	check: v.optional(v.boolean(), true),
})

const picklistValidators = formOptions({
	validators: {
		onChange: ({ value }) => {
			const result = v.safeParse(schema.PicklistSmartSchema, value)
			if (result.success) return
			const fields: Record<string, { message: string; dotPath: string }[]> = {}
			for (const issue of result.issues) {
				const path = (v.getDotPath(issue) ?? 'unknown').split('.')
				const name = path[0]
				fields[name] = (fields[name] ?? []).concat({
					message: issue.message,
					dotPath: path,
				})
			}
			return { fields }
		},
	},
})

export const AUTOFORM_CASES: AutoFormCase[] = [
	{
		id: 'picklist',
		label: 'Picklist Smart',
		description: '多尺寸枚举 + 多选组合，覆盖 clear/search/max 的智能默认。',
		schema: schema.PicklistSmartSchema,
		formOpts: picklistValidators,
	},
	{
		id: 'array',
		label: 'Array Showcase',
		description: '列表/网格/表格模式的数组操作以及默认值逻辑。',
		schema: schema.ArrayShowcaseSchema,
	},
	{
		id: 'record',
		label: 'Record Playground',
		description: 'Record 表单的多种模式（表格、列表、混合值类型）。',
		schema: schema.RecordAllInOneSchema,
	},
	{
		id: 'user',
		label: 'User Profile',
		description: '包含 slider、颜色选择与基础布尔字段的混合示例。',
		schema: UserSchema,
	},
	{
		id: 'object',
		label: 'Object Builder',
		description: '嵌套对象与 intersection 组合示例。',
		schema: schema.ObjectShowcaseSchema,
	},
]
