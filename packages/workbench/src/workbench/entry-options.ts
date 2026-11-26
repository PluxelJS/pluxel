const GROUP_ID = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/
const ROUTE_PARAMETER = /^[A-Za-z][A-Za-z0-9_]*$/
const ROUTE_LITERAL_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/

const WORKBENCH_ICONS = [
	'api',
	'brand-discord',
	'brand-telegram',
	'building',
	'chart-bar',
	'cloud-upload',
	'history',
	'message-chatbot',
	'plug-connected',
	'receipt',
	'search',
	'settings',
	'shield-lock',
	'test-pipe',
	'text-recognition',
	'typography',
	'users',
] as const

export type WorkbenchIcon = (typeof WORKBENCH_ICONS)[number]

const WORKBENCH_ICON_VALUES = new Set<string>(WORKBENCH_ICONS)

export type WorkbenchGroup = Readonly<{
	id: string
	label: string
	icon?: WorkbenchIcon
}>

export type WorkbenchTabPlacement = Readonly<{
	kind: 'tab'
	label?: string
	icon?: WorkbenchIcon
	group?: WorkbenchGroup
	order: number
}>

export type WorkbenchNavigation = Readonly<{
	label: string
	group?: WorkbenchGroup
}>

export type WorkbenchRoutePlacement = Readonly<{
	kind: 'route'
	path: string
	title: string
	icon?: WorkbenchIcon
	navigation?: WorkbenchNavigation
	frame: 'shell' | 'standalone'
	order: number
}>

export type WorkbenchPanelPlacement = Readonly<{
	kind: 'panel'
	region: 'left' | 'right' | 'bottom'
	label: string
	icon?: WorkbenchIcon
	order: number
}>

export type WorkbenchPlacement =
	| WorkbenchTabPlacement
	| WorkbenchRoutePlacement
	| WorkbenchPanelPlacement

/** Placement declarations default to order 0 and route frame 'shell'. */
export type WorkbenchPlacementInput =
	| (Omit<WorkbenchTabPlacement, 'order'> & { readonly order?: number })
	| (Omit<WorkbenchRoutePlacement, 'order' | 'frame'> & {
			readonly order?: number
			readonly frame?: WorkbenchRoutePlacement['frame']
	  })
	| (Omit<WorkbenchPanelPlacement, 'order'> & { readonly order?: number })

/** @internal Shared by runtime declarations and static compilation. */
export function parseWorkbenchPlacement(input: unknown): WorkbenchPlacement {
	if (!isPlainRecord(input)) {
		throw new TypeError('[workbench] placement must be a plain record')
	}
	switch (input.kind) {
		case 'tab': {
			assertExactKeys('tab', input, ['kind', 'label', 'icon', 'group', 'order'])
			return Object.freeze({
				kind: 'tab',
				...(input.label === undefined
					? {}
					: { label: requiredText('tab', 'label', input.label, 256) }),
				...(input.icon === undefined ? {} : { icon: readWorkbenchIcon(input.icon) }),
				...(input.group === undefined ? {} : { group: normalizeGroup('tab', input.group) }),
				order: finiteOrder('tab', input.order),
			})
		}
		case 'panel': {
			assertExactKeys('panel', input, ['kind', 'region', 'label', 'icon', 'order'])
			const region = input.region
			if (region !== 'left' && region !== 'right' && region !== 'bottom') {
				throw new TypeError('[workbench] panel region must be left, right, or bottom')
			}
			return Object.freeze({
				kind: 'panel',
				region,
				label: requiredText('panel', 'label', input.label, 256),
				...(input.icon === undefined ? {} : { icon: readWorkbenchIcon(input.icon) }),
				order: finiteOrder('panel', input.order),
			})
		}
		case 'route': {
			assertExactKeys('route', input, [
				'kind',
				'path',
				'title',
				'icon',
				'navigation',
				'frame',
				'order',
			])
			const path = readWorkbenchRoutePath(input.path)
			if (path.includes('/:') && input.navigation !== undefined) {
				throw new TypeError('[workbench] parameterized routes cannot enter navigation')
			}
			const frame = input.frame === undefined ? 'shell' : input.frame
			if (frame !== 'shell' && frame !== 'standalone') {
				throw new TypeError('[workbench] route frame must be shell or standalone')
			}
			return Object.freeze({
				kind: 'route',
				path,
				title: requiredText('route', 'title', input.title, 256),
				...(input.icon === undefined ? {} : { icon: readWorkbenchIcon(input.icon) }),
				...(input.navigation === undefined
					? {}
					: { navigation: normalizeNavigation(input.navigation) }),
				frame,
				order: finiteOrder('route', input.order),
			})
		}
		default:
			throw new TypeError('[workbench] placement kind must be tab, route, or panel')
	}
}

function normalizeNavigation(input: unknown): WorkbenchNavigation {
	assertExactKeys('route.navigation', input, ['label', 'group'])
	return Object.freeze({
		label: requiredText('route.navigation', 'label', input.label, 256),
		...(input.group === undefined
			? {}
			: { group: normalizeGroup('route.navigation', input.group) }),
	})
}

function normalizeGroup(api: string, input: unknown): WorkbenchGroup {
	assertExactKeys(`${api}.group`, input, ['id', 'label', 'icon'])
	return Object.freeze({
		id: requiredGroupId(api, input.id),
		label: requiredText(`${api}.group`, 'label', input.label, 256),
		...(input.icon === undefined ? {} : { icon: readWorkbenchIcon(input.icon) }),
	})
}

/** @internal Shared by runtime declarations and static compilation. */
export function parseWorkbenchSourcePath(field: 'renderer' | 'document', input: unknown): string {
	const path = requiredText('define', field, input, 2_048)
	if (!path.startsWith('./') && !path.startsWith('../')) {
		throw new TypeError(`[workbench] ${field} must be module-relative`)
	}
	if (path.includes('\\') || path.includes('?') || path.includes('#')) {
		throw new TypeError(`[workbench] ${field} must not contain \\, ? or #`)
	}
	if (field === 'document' && !path.toLowerCase().endsWith('.md')) {
		throw new TypeError('[workbench] document must use the .md extension')
	}
	return path
}

function readWorkbenchRoutePath(input: unknown): string {
	const path = requiredText('route', 'path', input, 2_048)
	if (path.includes('?') || path.includes('#') || path.includes('\\')) {
		throw new TypeError('[workbench] route path must not contain \\, ? or #')
	}
	if (path === '/') throw new TypeError('[workbench] route path must not be root')
	if (!path.startsWith('/') || path.endsWith('/')) {
		throw new TypeError('[workbench] route path must be canonical')
	}
	if (path.includes('//')) {
		throw new TypeError('[workbench] route path must not contain empty segments')
	}
	const parameters = new Set<string>()
	for (const segment of path.slice(1).split('/')) {
		if (segment.startsWith(':')) {
			const name = segment.slice(1)
			if (!ROUTE_PARAMETER.test(name)) {
				throw new TypeError(`[workbench] invalid route parameter "${segment}"`)
			}
			if (parameters.has(name)) {
				throw new TypeError(`[workbench] duplicate route parameter "${name}"`)
			}
			parameters.add(name)
		} else if (!ROUTE_LITERAL_SEGMENT.test(segment) || segment === '.' || segment === '..') {
			throw new TypeError(`[workbench] invalid literal route segment "${segment}"`)
		}
	}
	return path
}

function finiteOrder(api: string, value: unknown): number {
	if (value === undefined) return 0
	if (typeof value !== 'number' || !Number.isFinite(value))
		throw new TypeError(`[workbench] ${api}(): order must be finite`)
	return value
}

function requiredGroupId(api: string, value: unknown): string {
	const id = requiredText(`${api}.group`, 'id', value, 64)
	if (!GROUP_ID.test(id)) {
		throw new TypeError(`[workbench] ${api}.group: id has an invalid format`)
	}
	return id
}

function readWorkbenchIcon(value: unknown): WorkbenchIcon {
	if (typeof value !== 'string' || !WORKBENCH_ICON_VALUES.has(value)) {
		throw new TypeError('[workbench] icon is not part of the fixed Workbench icon set')
	}
	return value as WorkbenchIcon
}

function requiredText(api: string, field: string, value: unknown, max: number): string {
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		value.length > max ||
		value.trim() !== value
	) {
		throw new TypeError(
			`[workbench] ${api}(): ${field} must be non-empty without surrounding whitespace`,
		)
	}
	return value
}

export function requiredUtf8Text(
	api: string,
	field: string,
	value: unknown,
	maxBytes: number,
): string {
	const text = requiredText(api, field, value, maxBytes)
	if (new TextEncoder().encode(text).byteLength > maxBytes) {
		throw new TypeError(`[workbench] ${api}(): ${field} exceeds ${maxBytes} UTF-8 bytes`)
	}
	return text
}

export function assertExactKeys(
	api: string,
	value: unknown,
	allowed: readonly string[],
): asserts value is Record<string, unknown> {
	if (!isPlainRecord(value))
		throw new TypeError(`[workbench] ${api}(): options must be a plain record`)
	const extras = Object.keys(value).filter((key) => !allowed.includes(key))
	if (extras.length > 0) {
		throw new TypeError(`[workbench] ${api}(): unsupported option "${extras[0]}"`)
	}
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	const prototype = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
}
