import * as f from 'valibot-form'
import * as v from 'valibot'

export const configurationSchema = v.object({
	enabled: v.optional(
		v.pipe(
			v.boolean(),
			f.formMeta({
				label: '启用插件',
				section: { id: 'runtime', title: '运行时' },
			}),
			f.booleanMeta({}),
		),
		true,
	),
	mode: v.optional(
		v.pipe(
			v.picklist(['development', 'production'] as const),
			f.formMeta({ label: '运行环境', section: 'runtime' }),
			f.picklistMeta({
				control: 'segmented',
				labels: { development: '开发', production: '生产' },
			}),
		),
		'development',
	),
	endpoint: v.optional(
		v.pipe(
			v.string(),
			v.url(),
			f.formMeta({
				label: '上游地址',
				description: 'URL 约束来自 schema；表单只负责编辑。',
				section: { id: 'network', title: '网络与重试' },
			}),
			f.stringMeta({ placeholder: 'https://api.example.com' }),
		),
		'https://api.example.com',
	),
	port: v.optional(
		v.pipe(
			v.number(),
			v.integer(),
			v.minValue(1),
			v.maxValue(65535),
			f.formMeta({ label: '监听端口', section: 'network' }),
			f.numberMeta({ min: 1, max: 65535, step: 1 }),
		),
		8787,
	),
	retry: v.optional(
		v.pipe(
			v.object({
				attempts: v.optional(
					v.pipe(
						v.number(),
						v.integer(),
						v.minValue(1),
						f.formMeta({ label: '最大次数' }),
						f.numberMeta({ min: 1, max: 10, step: 1 }),
					),
					3,
				),
				backoffMs: v.optional(
					v.pipe(
						v.number(),
						v.integer(),
						v.minValue(100),
						f.formMeta({ label: '退避时间（毫秒）' }),
						f.numberMeta({ min: 100, step: 100 }),
					),
					250,
				),
			}),
			f.formMeta({ label: '重试策略', section: 'network' }),
			f.objectMeta({ variant: 'card', columns: 2 }),
		),
		{
			attempts: 3,
			backoffMs: 250,
		},
	),
	allowedOrigins: v.optional(
		v.pipe(
			v.array(v.pipe(v.string(), v.url())),
			f.formMeta({ label: '允许的 Origin', section: 'network' }),
			f.arrayMeta({
				layout: 'list',
				itemLabel: 'Origin',
				addLabel: '添加 Origin',
				defaultItem: 'https://api.example.com',
			}),
		),
		['https://api.example.com'],
	),
})
