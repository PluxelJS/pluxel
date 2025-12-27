// packages/hmr/tests/ui-demos/MarketUI.ts
// Demo plugin that provides the market UI via extension points.

import { BasePlugin, Plugin } from '@pluxel/core'

@Plugin({ name: 'MarketUI', type: 'event' })
export class MarketUI extends BasePlugin {
	override async init() {
		this.ctx.logger.info('[MarketUI] Initializing...')
		this.ctx.ext.ui.register({
			entryPath: './MarketUI/ui/index.tsx',
		})
		this.ctx.logger.info('[MarketUI] UI extensions registered')
	}
}
