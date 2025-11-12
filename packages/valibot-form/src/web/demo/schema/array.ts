import * as v from 'valibot'
import * as f from '~/index'

export const ArrayShowcaseSchema = v.object({
	tags: v.pipe(
		v.array(v.string()),
		f.arrayMeta({
			layout: 'list',
			addLabel: '添加标签',
			itemLabel: '标签',
			emptyHint: '还没有任何标签',
		}),
	),
	numbers: v.pipe(
		v.array(v.number()),
		f.arrayMeta({
			layout: 'grid',
			columns: 3,
			itemLabel: '数值',
			// 可选扩展：空数组新增时给默认值
			defaultItem: 100,
			maxItems: 6,
		}),
	),
	flags: v.pipe(
		v.array(v.boolean()),
		f.arrayMeta({
			layout: 'table',
			itemLabel: '开关',
			minItems: 1,
		}),
	),
	mixed: v.pipe(
		v.array(v.unknown()),
		f.arrayMeta({
			layout: 'list',
			itemLabel: '任意值',
			valueMode: 'auto',
		}),
	),
	multiPick: v.pipe(
		v.array(v.picklist(['alpha', 'beta', 'gamma', 'delta'] as const)),
		f.arrayMeta({
			valueMode: 'picklist',
			pickerMode: 'picker',
			picklist: {
				searchable: false,
				clearable: true,
				options: ['alpha', 'beta', 'gamma', 'delta'],
				labels: {
					alpha: '选项 A',
					beta: '选项 B',
					gamma: '选项 C',
					delta: '选项 D',
				},
			},
			emptyHint: '通过一个控件即可多选',
		}),
	),
})
