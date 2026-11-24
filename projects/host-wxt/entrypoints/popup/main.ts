import { browser } from 'wxt/browser'
import { applyPreferences, catalogUpdates, cleanLink, close } from '../../src/application'
import { watchPreferences } from '../../src/preferences'
import { watchConfig } from '../../src/config-storage'
import '../../assets/style.css'

const source = document.querySelector<HTMLTextAreaElement>('#source')!
const result = document.querySelector<HTMLOutputElement>('#result')!
const changes = document.querySelector<HTMLElement>('#changes')!
const status = document.querySelector<HTMLElement>('#status')!
const copy = document.querySelector<HTMLButtonElement>('#copy')!
const canonical = document.querySelector<HTMLButtonElement>('#canonical')!
let updateIssue = ''
let preferenceIssue = ''
let revision = 0

async function preview() {
	const current = ++revision
	copy.disabled = true
	result.value = ''
	changes.textContent = ''
	status.textContent = preferenceIssue || updateIssue
	if (preferenceIssue || !source.value.trim()) return
	try {
		const { link, changed } = await cleanLink(source.value)
		if (current !== revision) return
		result.value = link
		changes.textContent = changed.length > 0 ? changed.join(' · ') : '链接已可直接分享'
		copy.disabled = false
	} catch (error) {
		if (current === revision) status.textContent = String(error)
	}
}

async function syncPreferences() {
	try {
		await applyPreferences()
		preferenceIssue = ''
	} catch (error) {
		preferenceIssue = String(error)
	}
	await preview()
}

const unwatchConfig = watchConfig(() => void syncPreferences())
const unwatch = watchPreferences(() => void syncPreferences())
catalogUpdates.addEventListener('updated', (event) => {
	updateIssue = event instanceof CustomEvent ? event.detail : ''
	void preview()
})
window.addEventListener(
	'pagehide',
	() => {
		unwatch()
		unwatchConfig()
		void close().catch(console.error)
	},
	{ once: true },
)
source.addEventListener('input', () => void preview())
document.querySelector('#settings')!.addEventListener('click', () => {
	void browser.runtime.openOptionsPage().catch((error) => {
		status.textContent = String(error)
	})
})
copy.addEventListener('click', async () => {
	try {
		await navigator.clipboard.writeText(result.value)
		status.textContent = '已复制'
	} catch (error) {
		status.textContent = String(error)
	}
})

async function loadSource() {
	const fromMenu = new URLSearchParams(location.hash.slice(1)).get('link')
	if (fromMenu !== null) {
		source.value = fromMenu
		return
	}
	const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
	if (!tab?.url || !/^https?:\/\//i.test(tab.url) || tab.id === undefined) return
	if (!source.value) source.value = tab.url
	const tabId = tab.id
	canonical.hidden = false
	canonical.addEventListener('click', async () => {
		try {
			const [frame] = await browser.scripting.executeScript({
				target: { tabId },
				files: ['/content-scripts/canonical.js'],
			})
			if (typeof frame?.result !== 'string') {
				status.textContent = '此网页没有声明规范链接。'
				return
			}
			source.value = frame.result
			await preview()
		} catch (error) {
			status.textContent = String(error)
		}
	})
}

void loadSource()
	.then(syncPreferences)
	.catch((error) => {
		status.textContent = String(error)
	})
