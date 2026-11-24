import { browser } from 'wxt/browser'
import { defineBackground } from 'wxt/utils/define-background'

const menuId = 'clean-link'

export default defineBackground(() => {
	browser.runtime.onInstalled.addListener(async () => {
		await browser.contextMenus.removeAll()
		browser.contextMenus.create({
			id: menuId,
			title: '使用净链清理链接',
			contexts: ['link'],
			targetUrlPatterns: ['http://*/*', 'https://*/*'],
		})
	})
	browser.contextMenus.onClicked.addListener(async ({ menuItemId, linkUrl }) => {
		if (menuItemId === menuId && linkUrl) {
			const page = new URL(browser.runtime.getURL('/popup.html'))
			page.hash = new URLSearchParams({ link: linkUrl }).toString()
			await browser.tabs.create({ url: page.href })
		}
	})
})
