import { fileURLToPath } from 'node:url'
import { ui } from '@pluxel/hmr/plugin'
import { BasePlugin, Plugin } from '@pluxel/runtime'

const uiEntryPath = fileURLToPath(new URL('./ui/index.tsx', import.meta.url))
const marketUi = ui(uiEntryPath)

@Plugin({ name: 'MarketUI', type: 'event' })
export class MarketUI extends BasePlugin {
	override async init() {
		marketUi.bind(this.ctx)
	}
}

export default MarketUI
