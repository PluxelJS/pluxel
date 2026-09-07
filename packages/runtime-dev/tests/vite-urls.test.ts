import { describe, expect, it, vi } from 'vitest'
import type { ViteDevServer } from 'vite'
import { installPluxelViteUrlPrinter } from '../src/vite-urls'

function fixture(localUrl = 'http://127.0.0.1:43123/') {
	const info = vi.fn()
	const printUrls = vi.fn()
	const server = {
		config: { logger: { info } },
		resolvedUrls: { local: [localUrl], network: [] },
		printUrls,
	} as unknown as ViteDevServer
	return { server, info, printUrls }
}

describe('Pluxel Vite URL presentation', () => {
	it('preserves native Vite URLs and adds the Workbench mount', () => {
		const { server, info, printUrls } = fixture()
		installPluxelViteUrlPrinter(server, {
			workbenchBasePath: () => '/__pluxel/workbench',
		})

		server.printUrls()

		expect(printUrls).toHaveBeenCalledOnce()
		expect(info).toHaveBeenCalledWith('  ➜  Workbench:   http://127.0.0.1:43123/__pluxel/workbench')
	})

	it('uses the stable Portless origin for both application surfaces', () => {
		const { server, info, printUrls } = fixture()
		installPluxelViteUrlPrinter(server, {
			publicOrigin: 'https://rhythm.localhost',
			workbenchBasePath: () => '/__pluxel/workbench',
		})

		server.printUrls()

		expect(printUrls).not.toHaveBeenCalled()
		expect(info.mock.calls).toEqual([
			['  ➜  Application: https://rhythm.localhost/'],
			['  ➜  Workbench:   https://rhythm.localhost/__pluxel/workbench'],
		])
	})

	it('does not claim a separate application root when Workbench owns it', () => {
		const { server, info } = fixture()
		installPluxelViteUrlPrinter(server, {
			publicOrigin: 'https://admin.localhost',
			workbenchBasePath: () => '/',
		})

		server.printUrls()

		expect(info.mock.calls).toEqual([['  ➜  Workbench:   https://admin.localhost/']])
	})
})
