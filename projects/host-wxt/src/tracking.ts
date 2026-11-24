import { BasePlugin, Plugin } from '@pluxel/core'
import * as v from 'valibot'
import { formMeta } from 'valibot-form'
import { LinkCleaner } from './cleaner'

const TrackingConfig = v.object({
	extraParameters: v.optional(
		v.pipe(
			v.string(),
			v.regex(/^(?:[\w.-]+(?: *, *[\w.-]+)*)?$/, '请用逗号分隔参数名，例如 ref, fbclid。'),
			formMeta({
				title: '额外移除的参数',
				description: '用逗号分隔，例如 ref, fbclid。UTM 参数始终移除。',
			}),
		),
		'',
	),
})

@Plugin({ displayName: '移除 UTM 追踪参数' })
export class TrackingParameters extends BasePlugin {
	private readonly config = this.configs.use(TrackingConfig)
	private extra = new Set<string>()

	protected override init() {
		const apply = (value: string) => {
			this.extra = new Set(value.split(',').map((key) => key.trim().toLowerCase()))
		}
		apply(this.config.extraParameters)
		this.configs.onUpdate(this.config, ({ desired }) => apply(desired.extraParameters))
		return this.ctx.service(LinkCleaner).register('tracking', (link) => this.clean(link))
	}

	private clean(link: string): string {
		const url = new URL(link)
		// Retain the original encoding, order and duplicates of the surviving parameters.
		const parts = url.search.slice(1).split('&')
		const kept = parts.filter((part) => {
			const [key] = new URLSearchParams(part).keys()
			return !key || (!/^utm_/i.test(key) && !this.extra.has(key.toLowerCase()))
		})
		if (kept.length === parts.length) return link
		url.search = kept.join('&')
		return url.href
	}
}
