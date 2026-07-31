import type { Card } from '../types/message.ts'

export type KookCardContext = Readonly<{
	text: string
	iconUrl?: string
	/** @defaultValue "plain-text" */
	textType?: 'plain-text' | 'kmarkdown'
}>

export type KookCardAction =
	| Readonly<{
			type: 'link'
			label: string
			url: string
			theme?: Card.ButtonTheme
	  }>
	| Readonly<{
			type: 'return-val'
			label: string
			value: string
			theme?: Card.ButtonTheme
	  }>

/**
 * Common KOOK presentation layout. Advanced card modules remain available through the native
 * `Card` type instead of expanding this helper into a second card protocol.
 */
export type KookCardLayout = Readonly<{
	title: string
	description?: string
	/** Additional KMarkdown sections rendered after the description. */
	sections?: readonly string[]
	context?: KookCardContext
	/** Buttons rendered in a separate invisible card, wrapping every four actions into one row. */
	actions?: readonly KookCardAction[]
	/** Optional caption below the action group, inside the invisible card. */
	actionContext?: KookCardContext
	/** @defaultValue "secondary" */
	theme?: Card.VisibleTheme
	color?: string
	/** @defaultValue "lg" */
	size?: Card.Size
}>

/** Validate and serialize one complete KOOK Card message using the native wire contract. */
export function renderKookCardMessage(message: Card.Message): string {
	validateCardMessage(message)
	return JSON.stringify(message)
}

/** Render a polished content card followed by an invisible interaction card when actions exist. */
export function renderKookCard(layout: KookCardLayout): string {
	const title = requiredText(layout.title, 'title')
	const description = optionalText(layout.description, 'description')
	const sections = layout.sections?.map((section, index) =>
		requiredText(section, `sections[${index}]`),
	)
	const context = layout.context ? renderContext(layout.context, 'context') : undefined
	const size = layout.size ?? 'lg'
	const modules: Card.NonEmpty<Card.Module> = [
		{
			type: 'header',
			text: { type: 'plain-text', content: title },
		},
		...(description ? [markdownSection(description)] : []),
		...(sections?.map(markdownSection) ?? []),
		...(context ? [context] : []),
	]
	const contentCard: Card.Visible = {
		type: 'card',
		theme: layout.theme ?? 'secondary',
		size,
		...(layout.color ? { color: layout.color } : {}),
		modules,
	}

	if (layout.actions?.length) {
		const actionContext = layout.actionContext
			? renderContext(layout.actionContext, 'actionContext')
			: undefined
		const actionModules: Card.NonEmpty<Card.InvisibleModule> = [
			...renderActionGroups(layout.actions),
			...(actionContext ? [actionContext] : []),
		]
		return renderKookCardMessage([
			contentCard,
			{
				type: 'card',
				theme: 'invisible',
				size,
				modules: actionModules,
			},
		])
	} else if (layout.actionContext) {
		throw new TypeError('KOOK card actionContext requires at least one action')
	}

	return renderKookCardMessage([contentCard])
}

function markdownSection(content: string): Card.Section {
	return { type: 'section', text: { type: 'kmarkdown', content } }
}

function renderContext(value: KookCardContext, field: string): Card.Context {
	const text = requiredText(value.text, `${field}.text`)
	const textElement: Card.Text = { type: value.textType ?? 'plain-text', content: text }
	const elements: Card.NonEmpty<Card.Text | Card.Image> = value.iconUrl
		? [{ type: 'image', src: value.iconUrl }, textElement]
		: [textElement]
	return {
		type: 'context',
		elements,
	}
}

function renderActionGroups(actions: readonly KookCardAction[]): Card.NonEmpty<Card.ActionGroup> {
	const buttons = actions.map((action, index): Card.Button => {
		const label = requiredText(action.label, `actions[${index}].label`)
		if (action.type === 'link') {
			const url = validHttpUrl(action.url, `actions[${index}].url`)
			return {
				type: 'button',
				theme: action.theme ?? 'secondary',
				click: 'link',
				value: url,
				text: { type: 'plain-text', content: label },
			}
		}
		return {
			type: 'button',
			theme: action.theme ?? 'secondary',
			click: 'return-val',
			value: requiredText(action.value, `actions[${index}].value`),
			text: { type: 'plain-text', content: label },
		}
	})
	const groups: Card.ActionGroup[] = []
	for (let index = 0; index < buttons.length; index += 4) {
		const [first, second, third, fourth] = buttons.slice(index, index + 4)
		if (!first) throw new TypeError('KOOK card action group must not be empty')
		const elements: [Card.Button, Card.Button?, Card.Button?, Card.Button?] = [first]
		if (second) elements.push(second)
		if (third) elements.push(third)
		if (fourth) elements.push(fourth)
		groups.push({
			type: 'action-group',
			elements,
		})
	}
	const [firstGroup, ...restGroups] = groups
	if (!firstGroup) throw new TypeError('KOOK card actions must not be empty')
	return [firstGroup, ...restGroups]
}

const invisibleModuleTypes = new Set<Card.InvisibleModule['type']>([
	'section',
	'container',
	'header',
	'divider',
	'action-group',
	'context',
	'file',
	'audio',
	'video',
])

function validateCardMessage(message: Card.Message): void {
	const cards = message as readonly Card[]
	if (cards.length === 0 || cards.length > 5) {
		throw new TypeError('KOOK card message must contain one to five cards')
	}
	let moduleCount = 0
	const now = Date.now()
	for (const [cardIndex, card] of cards.entries()) {
		const field = `cards[${cardIndex}]`
		if (card.modules.length === 0)
			throw new TypeError(`KOOK card ${field}.modules must not be empty`)
		if (card.color !== undefined && !/^#[0-9a-f]{6}$/i.test(card.color)) {
			throw new TypeError(`KOOK card ${field}.color must be a six-digit hexadecimal color`)
		}
		moduleCount += card.modules.length
		if (moduleCount > 50) {
			throw new TypeError('KOOK card message accepts at most 50 modules in total')
		}
		for (const [moduleIndex, module] of card.modules.entries()) {
			const moduleField = `${field}.modules[${moduleIndex}]`
			if (card.theme === 'invisible') {
				if (!invisibleModuleTypes.has(module.type as Card.InvisibleModule['type'])) {
					throw new TypeError(`KOOK invisible card does not support ${module.type} modules`)
				}
				if (module.type === 'section' && 'accessory' in module) {
					throw new TypeError('KOOK invisible card sections do not support accessories')
				}
			}
			validateModule(module as Card.Module, moduleField, now)
		}
	}
}

function validateModule(module: Card.Module, field: string, now: number): void {
	switch (module.type) {
		case 'header':
			if (typeof module.text !== 'string' && module.text.type !== 'plain-text') {
				throw new TypeError(`KOOK card ${field}.text must be plain-text`)
			}
			validateText(module.text, `${field}.text`, 100)
			return
		case 'section':
			validateSectionText(module.text, `${field}.text`)
			if ('accessory' in module) {
				if (module.accessory.type === 'image') validateImage(module.accessory, `${field}.accessory`)
				else validateButton(module.accessory, `${field}.accessory`)
			}
			return
		case 'image-group':
		case 'container':
			validateCount(module.elements, 1, 9, `${field}.elements`)
			module.elements.forEach((image, index) => validateImage(image, `${field}.elements[${index}]`))
			return
		case 'action-group':
			validateCount(module.elements, 1, 4, `${field}.elements`)
			module.elements.forEach((button, index) =>
				validateButton(button!, `${field}.elements[${index}]`),
			)
			return
		case 'context':
			validateCount(module.elements, 1, 10, `${field}.elements`)
			module.elements.forEach((element, index) => {
				if (typeof element === 'object' && element.type === 'image') {
					validateImage(element, `${field}.elements[${index}]`)
				} else {
					validateText(element, `${field}.elements[${index}]`)
				}
			})
			return
		case 'divider':
			return
		case 'file':
		case 'video':
			assertHttpUrl(module.src, `${field}.src`)
			requiredText(module.title, `${field}.title`)
			return
		case 'audio':
			assertHttpUrl(module.src, `${field}.src`)
			requiredText(module.title, `${field}.title`)
			if (module.cover) assertHttpUrl(module.cover, `${field}.cover`)
			return
		case 'countdown':
			validateTimestamp(module.endTime, `${field}.endTime`, now)
			if (module.startTime !== undefined) {
				validateTimestamp(module.startTime, `${field}.startTime`, now)
				if (module.startTime > module.endTime) {
					throw new TypeError(`KOOK card ${field}.startTime must not exceed endTime`)
				}
			}
			return
		case 'invite':
			requiredText(module.code, `${field}.code`)
			return
		default:
			throw new TypeError(`Unsupported KOOK card module: ${(module as { type?: unknown }).type}`)
	}
}

function validateSectionText(value: Card.Text | Card.Paragraph, field: string): void {
	if (typeof value === 'object' && value.type === 'paragraph') {
		validateCount(value.fields, 1, 50, `${field}.fields`)
		value.fields.forEach((text, index) => validateText(text, `${field}.fields[${index}]`))
		return
	}
	validateText(value, field)
}

function validateText(value: Card.Text, field: string, maxLength?: number): void {
	if (typeof value === 'string') {
		validateTextContent(value, field, maxLength ?? 2_000)
		return
	}
	if (value.type === 'plain-text') {
		validateTextContent(value.content, `${field}.content`, maxLength ?? 2_000)
		return
	}
	if (value.type === 'kmarkdown') {
		validateTextContent(value.content, `${field}.content`, maxLength ?? 5_000)
		return
	}
	throw new TypeError(`KOOK card ${field} must be plain-text or kmarkdown`)
}

function validateTextContent(value: string, field: string, maxLength: number): void {
	if (!value.trim()) throw new TypeError(`KOOK card ${field} must not be empty`)
	if (value.length > maxLength) {
		throw new TypeError(`KOOK card ${field} must contain at most ${maxLength} characters`)
	}
}

function validateImage(image: Card.Image, field: string): void {
	assertHttpUrl(image.src, `${field}.src`)
	if (image.fallbackUrl) assertHttpUrl(image.fallbackUrl, `${field}.fallbackUrl`)
	if (image.alt !== undefined && image.alt.length > 2_000) {
		throw new TypeError(`KOOK card ${field}.alt must contain at most 2000 characters`)
	}
}

function validateButton(button: Card.Button, field: string): void {
	validateText(button.text, `${field}.text`)
	if (button.click === 'link') {
		assertHttpUrl(button.value, `${field}.value`)
	} else if (button.click === 'return-val') {
		requiredText(button.value, `${field}.value`)
	}
}

function validateCount(value: readonly unknown[], min: number, max: number, field: string): void {
	if (value.length < min || value.length > max) {
		throw new TypeError(`KOOK card ${field} must contain ${min}-${max} elements`)
	}
}

function validateTimestamp(value: number, field: string, now: number): void {
	if (!Number.isSafeInteger(value) || value < now) {
		throw new TypeError(`KOOK card ${field} must be a future millisecond timestamp`)
	}
}

function requiredText(value: string, field: string): string {
	const trimmed = value.trim()
	if (!trimmed) throw new TypeError(`KOOK card ${field} must not be empty`)
	return trimmed
}

function optionalText(value: string | undefined, field: string): string | undefined {
	return value === undefined ? undefined : requiredText(value, field)
}

function assertHttpUrl(value: string, field: string): void {
	validHttpUrl(value, field)
}

function validHttpUrl(value: string, field: string): string {
	let url: URL
	try {
		url = new URL(value)
	} catch (error) {
		throw new TypeError(`KOOK card ${field} must be an absolute HTTP(S) URL`, { cause: error })
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new TypeError(`KOOK card ${field} must be an absolute HTTP(S) URL`)
	}
	return url.toString()
}
