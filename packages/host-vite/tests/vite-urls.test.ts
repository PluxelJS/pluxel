import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ViteDevServer } from 'vite'
import { WriteStream } from 'node:tty'
import { installPluxelViteUrlPrinter, readViteUrlOutput } from '../src/internal/vite-urls'

const originalTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
const originalColorDepth = Object.getOwnPropertyDescriptor(process.stdout, 'getColorDepth')
beforeEach(() => {
	// A pipe with only isTTY patched lacks Node's native environment-aware detection.
	Object.defineProperty(process.stdout, 'getColorDepth', {
		value: WriteStream.prototype.getColorDepth,
		configurable: true,
	})
	vi.stubEnv('NODE_DISABLE_COLORS', undefined)
	vi.stubEnv('FORCE_COLOR', undefined)
	vi.stubEnv('NO_COLOR', '1')
})
afterEach(() => {
	vi.unstubAllEnvs()
	if (originalTty) Object.defineProperty(process.stdout, 'isTTY', originalTty)
	else Reflect.deleteProperty(process.stdout, 'isTTY')
	if (originalColorDepth) Object.defineProperty(process.stdout, 'getColorDepth', originalColorDepth)
	else Reflect.deleteProperty(process.stdout, 'getColorDepth')
})

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
	it.each([undefined, '', '1'])(
		'honors FORCE_COLOR with NO_COLOR=%j and keeps console transport plain',
		(noColor) => {
			vi.stubEnv('NO_COLOR', noColor)
			vi.stubEnv('FORCE_COLOR', '1')
			const { server, info } = fixture()
			installPluxelViteUrlPrinter(server, {
				publicOrigin: 'http://app.project.localhost:8088',
				workbenchBasePath: () => '/__pluxel/workbench',
			})
			server.printUrls()
			expect(info.mock.calls).toEqual([
				[
					'  \u001b[32m➜\u001b[39m  \u001b[1mApplication:\u001b[22m \u001b[36mhttp://app.project.localhost:8088/\u001b[39m',
				],
				[
					'  \u001b[32m➜\u001b[39m  \u001b[1mWorkbench:\u001b[22m   \u001b[36mhttp://app.project.localhost:8088/__pluxel/workbench\u001b[39m',
				],
			])
			expect(readViteUrlOutput(server)).toEqual([
				'  ➜  Application: http://app.project.localhost:8088/',
				'  ➜  Workbench:   http://app.project.localhost:8088/__pluxel/workbench',
			])
		},
	)

	it.each([
		{ name: 'NO_COLOR on a TTY', tty: true, noColor: '1', forceColor: undefined },
		{ name: 'FORCE_COLOR=0 on a TTY', tty: true, noColor: undefined, forceColor: '0' },
		{ name: 'non-TTY output', tty: false, noColor: undefined, forceColor: undefined },
	])('keeps $name free of styling', ({ tty, noColor, forceColor }) => {
		vi.stubEnv('NO_COLOR', noColor)
		vi.stubEnv('FORCE_COLOR', forceColor)
		Object.defineProperty(process.stdout, 'isTTY', { value: tty, configurable: true })
		const { server, info } = fixture()
		installPluxelViteUrlPrinter(server, {
			publicOrigin: 'http://app.project.localhost:8088',
			workbenchBasePath: () => '/',
		})
		server.printUrls()
		expect(info).toHaveBeenCalledExactlyOnceWith(
			'  ➜  Workbench:   http://app.project.localhost:8088/',
		)
	})

	it('preserves native Vite URLs and adds the Workbench mount', () => {
		const { server, info, printUrls } = fixture()
		installPluxelViteUrlPrinter(server, {
			workbenchBasePath: () => '/__pluxel/workbench',
		})

		server.printUrls()

		expect(printUrls).toHaveBeenCalledOnce()
		expect(info).toHaveBeenCalledWith('  ➜  Workbench:   http://127.0.0.1:43123/__pluxel/workbench')
	})

	it('uses the stable Pitchfork origin for both application surfaces', () => {
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

it('updates the current mount across Host replacement without nesting URL printers', () => {
	const { server, info, printUrls } = fixture()
	const first = installPluxelViteUrlPrinter(server, { workbenchBasePath: () => '/first' })
	first()
	const second = installPluxelViteUrlPrinter(server, { workbenchBasePath: () => '/second' })
	first()
	server.printUrls()
	expect(printUrls).toHaveBeenCalledOnce()
	expect(info).toHaveBeenCalledExactlyOnceWith('  ➜  Workbench:   http://127.0.0.1:43123/second')
	second()
	info.mockClear()
	server.printUrls()
	expect(printUrls).toHaveBeenCalledTimes(2)
	expect(info).not.toHaveBeenCalled()
})

it('reprints the current mount without writing to the background logger', () => {
	const { server, info } = fixture()
	let mount: string | undefined = '/admin'
	installPluxelViteUrlPrinter(server, {
		publicOrigin: 'http://app.project.localhost:8088',
		workbenchBasePath: () => mount,
	})
	const first = readViteUrlOutput(server)
	expect(info).not.toHaveBeenCalled()
	server.printUrls()
	expect(first).toEqual(info.mock.calls.map(([line]) => line))
	mount = '/'
	expect(readViteUrlOutput(server)).toEqual([
		'  ➜  Workbench:   http://app.project.localhost:8088/',
	])
	mount = undefined
	expect(readViteUrlOutput(server)).toEqual([
		'  ➜  Application: http://app.project.localhost:8088/',
	])
})
