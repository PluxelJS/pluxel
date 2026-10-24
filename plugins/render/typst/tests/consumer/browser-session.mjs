import assert from 'node:assert/strict'

/** Await release of only this test page's native sessions before closing Chromium. */
export function trackConsumerSessions(page) {
	const clients = new Map()
	const track = (request) => {
		const url = new URL(request.url())
		const id = request.headers()['x-typst-client']
		if (url.pathname === '/compile' && id) clients.set(id, url.origin)
	}
	page.on('request', track)
	return async () => {
		page.off('request', track)
		for (const [id, origin] of clients) {
			const response = await page.request.post(`${origin}/session/close`, {
				headers: { Origin: origin, 'X-Typst-Client': id },
				data: {},
			})
			assert.equal(response.status(), 204, await response.text())
		}
	}
}
