import { BasePlugin, Plugin } from '@pluxel/core'
import { Launcher, Desktop } from '@embedded-launcher/sdk'
@Plugin({ displayName: 'Native Actions' })
export class NativeActions extends BasePlugin {
	protected override init() {
		const desktop = this.ctx.require(Desktop)
		this.ctx.require(Launcher).register('desktop', async ({ text, limit, signal }) => {
			const actions = await desktop.list(signal)
			return actions
				.filter(
					(action) =>
						!text.trim() ||
						`${action.title} ${action.subtitle}`.toLowerCase().includes(text.toLowerCase()),
				)
				.slice(0, limit)
				.map((action) => ({
					id: action.id,
					title: action.title,
					subtitle: action.subtitle,
					action: {
						label: '执行',
						execute: async (actionSignal) => ({
							...(await desktop.execute(action.id, actionSignal)),
						}),
					},
				}))
		})
	}
}
