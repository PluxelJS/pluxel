import { BasePlugin, Plugin } from '@pluxel/core'
import * as v from 'valibot'
import { formMeta } from 'valibot-form'
import { LinkCleaner } from './cleaner'

const FragmentConfig = v.object({
	removeHashRoutes: v.optional(
		v.pipe(
			v.boolean(),
			formMeta({
				title: '同时移除哈希路由',
				description: '开启后也会去掉 #/ 或 #!/ 开头的应用内路径。',
			}),
		),
		false,
	),
})

@Plugin({ displayName: '移除页内锚点' })
export class PageFragment extends BasePlugin {
	private readonly config = this.configs.use(FragmentConfig)
	private removeHashRoutes = false

	protected override init() {
		this.removeHashRoutes = this.config.removeHashRoutes
		this.configs.onUpdate(this.config, ({ desired }) => {
			this.removeHashRoutes = desired.removeHashRoutes
		})
		return this.ctx.service(LinkCleaner).register('fragment', (link) => this.clean(link))
	}

	private clean(link: string): string {
		if (!this.removeHashRoutes && /^#!?\//.test(new URL(link).hash)) return link
		return link.split('#', 1)[0]!
	}
}
