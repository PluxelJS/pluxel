import * as v from 'valibot'
import * as f from 'valibot-form'

export const ArrayShowcaseSchema = v.object({
	tags: v.pipe(
		v.array(v.string()),
		f.arrayMeta({
			style: 'list',
			addable: true,
			removable: true,
			reorderable: true,
			itemLabel: '标签',
		}),
	),
	numbers: v.pipe(
		v.array(v.number()),
		f.arrayMeta({
			style: 'grid',
			columns: 3,
			addable: true,
			removable: true,
			reorderable: true,
			itemLabel: '数值',
			// 可选扩展：空数组新增时给默认值
			defaultItem: 100,
		}),
	),
	flags: v.pipe(
		v.array(v.boolean()),
		f.arrayMeta({
			style: 'table',
			addable: true,
			removable: true,
			itemLabel: '开关',
		}),
	),
	mixed: v.pipe(
		v.array(v.unknown()),
		f.arrayMeta({
			style: 'list',
			addable: true,
			removable: true,
			reorderable: true,
			itemLabel: '任意值',
		}),
	),
})
