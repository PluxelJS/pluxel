import { expect, it, vi } from 'vitest'
import { browser } from 'wxt/browser'
import background from '../entrypoints/background'

// WXT's fake browser implements runtime and tabs. Supply the native menu event.
vi.mock('wxt/browser', async () => {
	const { fakeBrowser } = await import('wxt/testing/fake-browser')
	return {
		browser: {
			runtime: fakeBrowser.runtime,
			tabs: fakeBrowser.tabs,
			contextMenus: { onClicked: { addListener: vi.fn() } },
		},
	}
})

it('opens the selected link in the extension page, preserving its query and fragment', async () => {
	background.main()
	const [click] = vi.mocked(browser.contextMenus.onClicked.addListener).mock.calls[0]!
	const linkUrl = 'https://example.org/view?item=a%26b&utm_source=mail#part'
	const open = vi.spyOn(browser.tabs, 'create')
	try {
		await click({ menuItemId: 'other', editable: false, linkUrl })
		await click({ menuItemId: 'clean-link', editable: false })
		expect(open).not.toHaveBeenCalled()
		await click({ menuItemId: 'clean-link', editable: false, linkUrl })
		expect(open).toHaveBeenCalledTimes(1)
		const url = new URL(open.mock.calls[0]![0].url!)
		expect(url.href.split('#')[0]).toBe(browser.runtime.getURL('/popup.html'))
		expect(new URLSearchParams(url.hash.slice(1)).get('link')).toBe(linkUrl)
	} finally {
		open.mockRestore()
	}
})
