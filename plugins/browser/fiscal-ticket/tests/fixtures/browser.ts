import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import { vi } from 'vitest'
import type { FiscalTicketInput } from '../../src/index.ts'

const html = readFileSync(new URL('./portal.html', import.meta.url), 'utf8')

/** DOM-backed SDK fixture; replaces only the external CDP browser, never the Pluxel host. */
export class BrowserFixture extends EventEmitter {
	readonly contexts: ContextFixture[] = []
	connected = true
	onSubmit: (context: ContextFixture) => void = () => {}
	readonly newContext = vi.fn(async () => {
		const context = new ContextFixture(this)
		this.contexts.push(context)
		return context as unknown as BrowserContext
	})
	readonly close = vi.fn(async () => {
		this.connected = false
		this.emit('disconnected')
	})
	isConnected() {
		return this.connected
	}
	asBrowser() {
		return this as unknown as Browser
	}
}

export class ContextFixture extends EventEmitter {
	readonly dom = new JSDOM(html)
	readonly document = this.dom.window.document
	readonly fills = new Map<string, string>()
	closed = false
	readonly page = {
		goto: vi.fn(async () => null),
		locator: (selector: string) => new LocatorFixture(this, this.document, selector),
	}
	readonly newPage = vi.fn(async () => this.page as unknown as Page)
	readonly close = vi.fn(async () => {
		if (this.closed) return
		this.closed = true
		this.emit('close')
		this.dom.window.close()
	})
	setDefaultTimeout() {}
	setDefaultNavigationTimeout() {}
	constructor(readonly browser: BrowserFixture) {
		super()
	}
	challenge() {
		this.document.querySelector('.diaVerify')!.removeAttribute('style')
	}
	result(ticket: FiscalTicketInput, template = 1) {
		this.document.querySelector('.diaVerify')!.setAttribute('style', 'display:none')
		this.document.querySelector('.wrapper_billshow')!.removeAttribute('style')
		const target = this.document.querySelectorAll('.bill-content')[template]
		for (const [selector, value] of Object.entries({
			'#EInvoiceCode': ticket.code,
			'#EInvoiceNumber': ticket.number,
			'#RandomNumber': ticket.checkCode,
			'#IssueDate': ticket.issueDate,
			'td span': ticket.amount,
		})) {
			target.querySelector(selector)!.textContent = value
		}
	}
	message(text: string) {
		const message = this.document.createElement('div')
		message.className = 'el-message'
		const content = this.document.createElement('p')
		content.className = 'el-message__content'
		content.textContent = text
		message.append(content)
		this.document.body.append(message)
	}
}

class LocatorFixture {
	constructor(
		private context: ContextFixture,
		private root: ParentNode,
		private selector: string,
	) {}
	private elements(): Element[] {
		if (this.context.closed) throw new Error('Fixture page closed')
		const elements = [...this.root.querySelectorAll(this.selector.replaceAll(':visible', ''))]
		return this.selector.includes(':visible') ? elements.filter(visible) : elements
	}
	private one(): Element {
		const elements = this.elements()
		if (elements.length !== 1)
			throw new Error(`Expected exactly one ${this.selector}, got ${elements.length}`)
		return elements[0]
	}
	locator(selector: string) {
		return new LocatorFixture(this.context, this.one(), selector)
	}
	async fill(value: string) {
		const element = this.one() as HTMLInputElement
		element.value = value
		this.context.fills.set(this.selector, value)
	}
	async press(key: string) {
		if (key !== 'Tab') throw new Error('Unsupported fixture key')
	}
	async click() {
		this.one()
		this.context.browser.onSubmit(this.context)
	}
	async isVisible() {
		const elements = this.elements()
		return elements.length > 0 && visible(elements[0])
	}
	async count() {
		return this.elements().length
	}
	async evaluateAll<T>(fn: (elements: Element[]) => T) {
		return fn(this.elements())
	}
	async allTextContents() {
		return this.elements().map((element) => element.textContent ?? '')
	}
}
function visible(element: Element): boolean {
	let current: Element | null = element
	while (current) {
		if (current.getAttribute('style')?.includes('display:none')) return false
		current = current.parentElement
	}
	return true
}
