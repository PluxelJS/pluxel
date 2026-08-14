import { describe, expect, it } from 'vitest'

import { createDevRenderer } from '../../src/server/dev'
import { createHmrRenderer } from '../../src/server/hmr'
import { renderRuntimeUiHtml } from '../../src/server/html'

const assets = {
	js: '/src/client.tsx',
	css: [],
	preload: [],
}

describe('runtime UI HTML rendering', () => {
	it('keeps static UI HTML free of React refresh preamble', () => {
		const html = renderRuntimeUiHtml(assets, {
			target: 'static-built',
			uiBasePath: '/__pluxel/workbench',
		})

		expect(html).toContain('<script type="module" src="/src/client.tsx"></script>')
		expect(html).toContain(
			'<meta name="pluxel-workbench-ui-base-path" content="/__pluxel/workbench" />',
		)
		expect(html).not.toContain('/@react-refresh')
		expect(html).not.toContain('window.$RefreshReg$')
	})

	it('adds React refresh preamble for dev and HMR renderers', async () => {
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
			expect(html).toContain('import { injectIntoGlobalHook } from "/@react-refresh"')
			expect(html).toContain('window.$RefreshReg$ = () => {}')
			expect(html).toContain('window.$RefreshSig$ = () => (type) => type')
		}
	})
})
