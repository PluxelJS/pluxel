import * as v from 'valibot'
import type { TypstSourceComponent } from '@pluxel/plugin-typst/source'

export const entry = 'main.typ'
export const bodyPaths = ['sections/analysis.typ', 'sections/actions.typ'] as const
export const dataPath = 'data/sales.json'
export const dataSchema = v.strictObject({
	company: v.string(),
	quarter: v.string(),
	revenue: v.pipe(v.number(), v.minValue(0)),
	previousRevenue: v.pipe(v.number(), v.minValue(0.01)),
	renewalRate: v.pipe(v.number(), v.minValue(0), v.maxValue(100)),
})
export const components: readonly TypstSourceComponent[] = [
	{
		module: 'template/blocks.typ',
		name: 'metrics',
		label: '指标卡',
		parameters: { title: { type: 'string' as const, label: '标题' } },
		data: 'data',
	},
	{
		module: 'template/blocks.typ',
		name: 'revenue-chart',
		label: '营收图',
		parameters: {},
		data: 'data',
	},
]
