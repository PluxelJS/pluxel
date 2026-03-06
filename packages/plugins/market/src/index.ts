import { fileURLToPath } from 'node:url'
import { BasePlugin, Plugin } from '@pluxel/hmr'

const uiEntryPath = fileURLToPath(new URL('./ui/index.tsx', import.meta.url))

@Plugin({ name: 'MarketUI', type: 'event' })
export class MarketUI extends BasePlugin {
	override async init() {
		this.ctx.ext.ui.register({ entryPath: uiEntryPath })
	}
}

export default MarketUI
