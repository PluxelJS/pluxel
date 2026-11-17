import { BasePlugin, Plugin } from '@pluxel/core'
import type { ExampleResponse, ThemeVersion } from './protocol'

// The docs Vite transform compiles the color query as a second version of this same entry.
const themeVersion: ThemeVersion = 'classic'

@Plugin()
export class ThemePlugin extends BasePlugin {
	readonly version: ThemeVersion = themeVersion

	override init() {
		postMessage({
			type: 'lifecycle',
			message: `ThemePlugin ${this.version} 已启动。`,
		} satisfies ExampleResponse)
		this.ctx.effects.defer(() => {
			postMessage({
				type: 'lifecycle',
				message: `ThemePlugin ${this.version} 已停止。`,
			} satisfies ExampleResponse)
		})
	}

	preamble(): string {
		return this.version === 'color'
			? `#show heading: set text(fill: rgb("13795b"))
#set table(fill: (x, y) => if y == 0 { rgb("dff2e8") } else { none }, stroke: .5pt + rgb("9cc7b0"))
`
			: `#show heading: set text(fill: black)
#set table(fill: none, stroke: .5pt + black)
`
	}
}
