import { f, v } from '@pluxel/runtime'

function isHttpOrigin(value: string): boolean {
	const url = new URL(value)
	return (
		(url.protocol === 'http:' || url.protocol === 'https:') &&
		!url.username &&
		!url.password &&
		url.pathname === '/' &&
		!url.search &&
		!url.hash
	)
}

const HttpOrigin = v.pipe(
	v.string(),
	v.url(),
	v.check(isHttpOrigin, '必须是没有路径、查询参数或凭据的 HTTP(S) origin'),
)

export const WretchConfig = v.object({
	timeoutMs: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 30_000),
		f.formMeta({ title: '请求超时', description: '每次底层 fetch attempt 的超时（毫秒）' }),
		f.numberMeta({ step: 1_000 }),
	),
	maxConcurrentRequests: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 64),
		f.formMeta({ title: '最大并发请求', description: '所有 consumer 共用的 fetch attempt 上限' }),
		f.numberMeta({ step: 1 }),
	),
	maxQueuedRequests: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 256),
		f.formMeta({ title: '最大等待请求', description: '并发满时允许进入等待队列的请求数' }),
		f.numberMeta({ step: 1 }),
	),
	allowedOrigins: v.pipe(
		v.optional(v.array(HttpOrigin), []),
		f.formMeta({ title: '允许的 Origins', description: '空列表不限制；非空时使用精确 origin' }),
		f.arrayMeta({ layout: 'list', addLabel: '添加 Origin', itemLabel: 'Origin' }),
	),
})

export type WretchPluginConfig = v.InferOutput<typeof WretchConfig>
