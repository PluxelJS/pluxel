import { defineContentScript } from 'wxt/utils/define-content-script'

export default defineContentScript({
	registration: 'runtime',
	main() {
		return document.querySelector<HTMLLinkElement>('link[rel~="canonical" i][href]')?.href ?? null
	},
})
