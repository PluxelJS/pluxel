import { f, v } from '@pluxel/runtime'

export const WretchExampleConfig = v.object({
	baseUrl: v.pipe(
		v.optional(v.pipe(v.string(), v.url()), 'https://httpbingo.org'),
		f.formMeta({ label: '示例上游', description: 'WretchExamplePlugin 调用的 HTTP API base URL' }),
		f.stringMeta({ placeholder: 'https://httpbingo.org' }),
	),
	inspectPath: v.pipe(
		v.optional(v.pipe(v.string(), v.startsWith('/')), '/get'),
		f.formMeta({ label: '检查路径', description: '必须是以 / 开头的相对 API 路径' }),
		f.stringMeta({ placeholder: '/get' }),
	),
	retryAttempts: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(5)), 1),
		f.formMeta({
			label: 'GET 重试次数',
			description: '0 表示关闭；使用 Wretch 原生 retry middleware',
		}),
		f.numberMeta({ min: 0, max: 5, step: 1, integer: true }),
	),
})

export type WretchExampleConfigValue = v.InferOutput<typeof WretchExampleConfig>
