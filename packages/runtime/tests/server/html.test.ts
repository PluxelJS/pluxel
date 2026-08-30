import { describe, expect, it } from 'vitest'

import { DEV_ASSETS } from '../../src/server/assets'
import { createDevRenderer } from '../../src/server/dev'
import { createHmrRenderer } from '../../src/server/hmr'
import { renderRuntimeUiHtml } from '../../src/server/html'

const assets = {
	js: '/src/client.tsx',
	css: [],
	preload: [],
}

describe('runtime UI HTML rendering', () => {
	it('renders the runtime UI document without assuming a React refresh endpoint', () => {
		const html = renderRuntimeUiHtml(assets, {
			uiBasePath: '/__pluxel/workbench',
		})

		expect(html).toContain('<script type="module" src="/src/client.tsx"></script>')
		expect(html).toContain(
			'<meta name="pluxel-workbench-ui-base-path" content="/__pluxel/workbench" />',
		)
		expect(html).not.toContain('/@react-refresh')
		expect(html).not.toContain('window.$RefreshReg$')
	})

	it('keeps dev and HMR renderers independent of React refresh', async () => {
		const [devHtml, hmrHtml] = await Promise.all([
			Promise.resolve(createDevRenderer()(new Request('http://local.test/'))).then((response) =>
				response.text(),
			),
			Promise.resolve(createHmrRenderer()(new Request('http://local.test/'))).then((response) =>
				response.text(),
			),
		])

		for (const html of [devHtml, hmrHtml]) {
			expect(html).toContain('<meta name="pluxel-workbench-ui-base-path" content="/" />')
			expect(html).toContain(`<script type="module" src="${DEV_ASSETS.js}"></script>`)
			expect(html).not.toContain('/@react-refresh')
			expect(html).not.toContain('window.$RefreshReg$')
		}
	})
})
