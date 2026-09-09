import { MantineProvider } from '@mantine/core'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as v from 'valibot'
import { extractFormFields, type FieldNode } from '../core/fields'
import { unionMeta } from '../core'
import { AutoForm, useAutoFormCtx } from '../web/components/AutoForm'
import { FieldRenderer } from '../web/components/internal/FieldRenderer'

vi.mock('../web/components/internal/FieldRenderer', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../web/components/internal/FieldRenderer')>()
	return { ...actual, FieldRenderer: vi.fn(actual.FieldRenderer) }
})

let container: HTMLDivElement
let root: Root
let ctx: ReturnType<typeof useAutoFormCtx>

function FormObserver(): null {
	ctx = useAutoFormCtx()
	return null
}

beforeEach(() => {
	vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
	Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
		configurable: true,
		value: vi.fn(),
	})
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	vi.stubGlobal(
		'matchMedia',
		vi.fn(() => ({
			matches: false,
			addEventListener() {},
			removeEventListener() {},
			addListener() {},
			removeListener() {},
		})),
	)
	container = document.createElement('div')
	document.body.append(container)
	root = createRoot(container)
})

afterEach(async () => {
	await act(async () => root.unmount())
	container.remove()
	vi.unstubAllGlobals()
})

async function mount(
	defaultValues: Record<string, unknown>,
	fields?: FieldNode[],
	onSubmit?: (formApi: ReturnType<typeof useAutoFormCtx>['form']) => void,
	onChange?: () => void,
) {
	const schema = v.object({
		database: v.object({ host: v.string(), user: v.string() }),
		servers: v.array(v.object({ host: v.string() })),
	})
	const submitted = vi.fn()
	await act(async () =>
		root.render(
			<MantineProvider>
				<AutoForm
					fields={fields ?? extractFormFields(schema)}
					formOpts={{
						defaultValues,
						listeners: { onChange },
						onSubmit: ({
							value,
							formApi,
						}: {
							value: unknown
							formApi: ReturnType<typeof useAutoFormCtx>['form']
						}) => {
							submitted(value)
							onSubmit?.(formApi)
						},
					}}
				>
					<AutoForm.Fields />
					<FormObserver />
					<AutoForm.Actions>
						{({ reset }) => (
							<button type="button" onClick={() => reset()}>
								Reset
							</button>
						)}
					</AutoForm.Actions>
					<button type="submit">Save</button>
				</AutoForm>
			</MantineProvider>,
		),
	)
	return submitted
}

function input(name: string) {
	const element = container.querySelector<HTMLInputElement>(`input[name="${name}"]`)
	expect(element, `input ${name} must be rendered`).not.toBeNull()
	return element!
}

async function edit(name: string, value: string) {
	await editElement(input(name), value)
}

async function editElement(element: HTMLInputElement, value: string) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
		element.dispatchEvent(new Event('input', { bubbles: true }))
	})
}

async function clickButton(label: string, index = 0) {
	const buttons = [...container.querySelectorAll('button')].filter(
		(button) => button.getAttribute('aria-label') === label || button.textContent === label,
	)
	expect(buttons[index], `button ${label} ${index} must exist`).toBeDefined()
	await act(async () => buttons[index]!.click())
}

const defaults = () => ({
	database: { host: 'db.local', user: 'reader' },
	servers: [{ host: 'one' }, { host: 'two' }, { host: 'three' }],
})

describe('AutoForm field binding', () => {
	it('tracks nested blur independently and resets values and leaf metadata', async () => {
		await mount(defaults())
		await act(async () =>
			input('database.host').dispatchEvent(new FocusEvent('focusout', { bubbles: true })),
		)
		expect(ctx.form.getFieldMeta('database.host')?.isBlurred).toBe(true)
		expect(ctx.form.getFieldMeta('database.user')?.isBlurred).toBe(false)
		await edit('database.host', 'db.changed')
		expect(ctx.form.state.values).toEqual({
			...defaults(),
			database: { host: 'db.changed', user: 'reader' },
		})
		await clickButton('Reset')
		expect(input('database.host').value).toBe('db.local')
		expect(ctx.form.getFieldMeta('database.host')?.isBlurred).toBe(false)
		expect(ctx.form.state.isDirty).toBe(false)
	})

	it('shows full-path server errors and permits a corrected submission', async () => {
		const submitted = await mount(defaults())
		await act(async () =>
			ctx.form.setErrorMap({ onServer: { fields: { 'database.host': 'Host rejected' } } } as never),
		)
		expect(container.textContent).toContain('Host rejected')
		expect(ctx.form.getFieldMeta('database.host')?.errors).toContain('Host rejected')
		expect(ctx.form.getFieldMeta('database.user')?.errors).toEqual([])
		await edit('database.host', 'accepted.local')
		expect(container.textContent).not.toContain('Host rejected')
		await clickButton('Save')
		expect(submitted).toHaveBeenCalledWith({
			...defaults(),
			database: { host: 'accepted.local', user: 'reader' },
		})
	})

	it('clears only an edited leaf server issue while preserving an independent sibling issue', async () => {
		await mount(defaults())
		await act(async () =>
			ctx.form.setErrorMap({
				onServer: {
					fields: {
						'database.host': 'Host rejected',
						'database.user': 'User rejected',
					},
				},
			} as never),
		)
		await edit('database.host', 'fixed')
		expect(ctx.form.getFieldMeta('database.host')?.errors).toEqual([])
		expect(ctx.form.getFieldMeta('database.user')?.errors).toContain('User rejected')
		expect(container.textContent).toContain('User rejected')
	})

	it('edits, moves and removes object array rows and submits the resulting order', async () => {
		const submitted = await mount(defaults())
		await edit('servers[1].host', 'two.changed')
		await clickButton('上移', 1)
		expect(input('servers[0].host').value).toBe('two.changed')
		expect(input('servers[1].host').value).toBe('one')
		await clickButton('删除', 1)
		expect(input('servers[1].host').value).toBe('three')
		await clickButton('Save')
		expect(submitted).toHaveBeenCalledWith({
			...defaults(),
			servers: [{ host: 'two.changed' }, { host: 'three' }],
		})
		await clickButton('Reset')
		expect(input('servers[2].host').value).toBe('three')
		expect(ctx.form.state.values).toEqual(defaults())
	})

	it('moves array leaf interaction metadata and invalidates affected server errors without restoring stale paths', async () => {
		await mount(defaults())
		await act(async () => {
			input('servers[1].host').dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
			ctx.form.setErrorMap({
				onServer: { fields: { 'servers[1].host': 'Second host rejected' } },
			} as never)
		})
		await clickButton('上移', 1)
		expect(input('servers[0].host').value).toBe('two')
		expect(ctx.form.getFieldMeta('servers[0].host')?.isBlurred).toBe(true)
		expect(ctx.form.getFieldMeta('servers[1].host')?.isBlurred).toBe(false)
		expect(ctx.form.getFieldMeta('servers[0].host')?.errors).toEqual([])
		expect(ctx.form.getFieldMeta('servers[1].host')?.errors).toEqual([])
		await edit('database.user', 'new-user')
		expect(ctx.form.getFieldMeta('servers[0].host')?.errors).toEqual([])
		expect(ctx.form.getFieldMeta('servers[1].host')?.errors).toEqual([])
	})

	it('routes a server issue to an object array leaf without marking sibling rows invalid', async () => {
		await mount(defaults())
		await act(async () =>
			ctx.form.setErrorMap({
				onServer: { fields: { 'servers[1].host': 'Second host rejected' } },
			} as never),
		)
		expect(container.textContent).toContain('Second host rejected')
		expect(ctx.form.getFieldMeta('servers[1].host')?.errors).toContain('Second host rejected')
		expect(ctx.form.getFieldMeta('servers[0].host')?.errors).toEqual([])
		await clickButton('删除', 0)
		expect(input('servers[0].host').value).toBe('two')
		expect(ctx.form.getFieldMeta('servers[0].host')?.errors).toEqual([])
		expect(ctx.form.getFieldMeta('servers[1].host')?.errors).toEqual([])
		await act(async () =>
			ctx.form.setErrorMap({
				onServer: { fields: { 'servers[0].host': 'Updated path rejected' } },
			} as never),
		)
		expect(ctx.form.getFieldMeta('servers[0].host')?.errors).toContain('Updated path rejected')
		expect(ctx.form.getFieldMeta('servers[1].host')?.errors).toEqual([])
		await edit('servers[0].host', 'two.fixed')
		expect(container.textContent).not.toContain('Updated path rejected')
		expect(container.textContent).not.toContain('Second host rejected')
	})
})

describe('AutoForm structured editor drafts', () => {
	it('preserves inactive union branches during editing and discards them on reset', async () => {
		const fields = extractFormFields(
			v.object({
				connection: v.pipe(
					v.variant('type', [
						v.object({ type: v.literal('local'), file: v.string() }),
						v.object({ type: v.literal('remote'), url: v.string() }),
					]),
					unionMeta({ control: 'radio', preserve: true }),
				),
			}),
		)
		await mount({ connection: { type: 'local', file: 'initial.db' } }, fields)
		const selectBranch = async (index: number) => {
			const radio = container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[index]
			expect(radio).toBeDefined()
			await act(async () => radio!.click())
		}
		await edit('connection.file', 'draft.db')
		await selectBranch(1)
		await edit('connection.url', 'https://draft.example')
		await selectBranch(0)
		expect(input('connection.file').value).toBe('draft.db')
		await clickButton('Reset')
		expect(input('connection.file').value).toBe('initial.db')
		await selectBranch(1)
		expect(input('connection.url').value).toBe('')
		await clickButton('Reset')
		expect(input('connection.file').value).toBe('initial.db')
	})

	it('renames record keys and edits literal dotted and numeric keys without creating nested values', async () => {
		const fields = extractFormFields(v.object({ labels: v.record(v.string(), v.string()) }))
		const initial = { labels: { alpha: 'first', 'x.y': 'dotted', '0': 'numeric' } }
		const submitted = await mount(initial, fields)
		const byValue = (value: string) => {
			const element = [...container.querySelectorAll<HTMLInputElement>('input')].find(
				(el) => el.value === value,
			)
			expect(element, `input value ${value} must exist`).toBeDefined()
			return element!
		}
		await editElement(byValue('alpha'), 'beta')
		await editElement(byValue('dotted'), 'dotted.changed')
		await editElement(byValue('numeric'), 'numeric.changed')
		await clickButton('Save')
		expect(submitted).toHaveBeenCalledWith({
			labels: { beta: 'first', 'x.y': 'dotted.changed', '0': 'numeric.changed' },
		})
		await clickButton('Reset')
		expect(ctx.form.state.values).toEqual(initial)
		expect(byValue('alpha')).toBeDefined()
	})
})

it('invalidates inactive union drafts when onSubmit resets its supplied formApi', async () => {
	const fields = extractFormFields(
		v.object({
			connection: v.pipe(
				v.variant('type', [
					v.object({ type: v.literal('local'), file: v.string() }),
					v.object({ type: v.literal('remote'), url: v.string() }),
				]),
				unionMeta({ control: 'radio', preserve: true }),
			),
		}),
	)
	const submitted = await mount(
		{ connection: { type: 'local', file: 'initial.db' } },
		fields,
		(formApi) => formApi.reset(),
	)
	const selectBranch = async (index: number) => {
		await act(async () =>
			container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[index]!.click(),
		)
	}
	await selectBranch(1)
	await edit('connection.url', 'https://draft.example')
	await selectBranch(0)
	await clickButton('Save')
	expect(submitted).toHaveBeenCalledOnce()
	await selectBranch(1)
	expect(input('connection.url').value).toBe('')
})

it('preserves unaddressable root keys read-only while safe sibling edits still notify and submit', async () => {
	// TanStack cannot address literal dotted/numeric/empty root keys or replace
	// the whole root through a field path. Rendering them read-only prevents
	// accidental nested writes; literal keys below a safe parent remain editable.
	const fields = extractFormFields(
		v.object({
			'x.y': v.string(),
			'0': v.string(),
			'': v.pipe(v.string(), v.title('Empty root key')),
			normal: v.string(),
		}),
	)
	const initial = { 'x.y': 'dotted', '0': 'numeric', '': 'empty-key', normal: 'unchanged' }
	const onChange = vi.fn()
	const submitted = await mount(initial, fields, undefined, onChange)
	const editableInputs = [...container.querySelectorAll<HTMLInputElement>('input')].filter(
		(element) => !element.readOnly && !element.disabled,
	)
	expect(editableInputs.map((element) => element.name)).toEqual(['normal'])
	expect(container.textContent).toContain('Empty root key')
	expect(ctx.form.state.values).toEqual(initial)
	expect(ctx.form.state.isDirty).toBe(false)
	await edit('normal', 'edited')
	expect(ctx.form.state.values).toEqual({ ...initial, normal: 'edited' })
	expect(ctx.form.state.isDirty).toBe(true)
	expect(onChange).toHaveBeenCalled()
	await clickButton('Save')
	expect(submitted).toHaveBeenCalledWith({ ...initial, normal: 'edited' })
	await clickButton('Reset')
	expect(ctx.form.state.values).toEqual(initial)
	expect(ctx.form.state.isDirty).toBe(false)
})

it('initializes the selected discriminator when editing an initially empty union', async () => {
	const fields = extractFormFields(
		v.object({
			connection: v.pipe(
				v.variant('type', [
					v.object({ type: v.literal('local'), file: v.string() }),
					v.object({ type: v.literal('remote'), url: v.string() }),
				]),
				unionMeta({ control: 'radio' }),
			),
		}),
	)
	const submitted = await mount({ connection: {} }, fields)
	await edit('connection.file', 'created.db')
	await clickButton('Save')
	expect(submitted).toHaveBeenCalledWith({ connection: { type: 'local', file: 'created.db' } })
})

it.each(['readOnly', 'disabled', 'hidden'] as const)(
	'respects %s metadata on same-path union branch controls',
	async (flag) => {
		const fields = extractFormFields(v.object({ setting: v.union([v.string(), v.number()]) }))
		const union = fields[0]!
		expect(union.kind).toBe('union')
		if (union.kind !== 'union') throw new Error('Expected union plan')
		const branch = union.branches[0]!.fields[0]!
		expect(branch.replaceValue).toBe(true)
		branch.node = { ...branch.node, meta: { ...branch.node.meta, [flag]: true } }
		const submitted = await mount({ setting: 'original' }, fields)
		const control = container.querySelector<HTMLInputElement>('input[name="setting"]')
		expect(flag === 'hidden' ? control === null : control?.[flag]).toBe(true)
		if (flag !== 'hidden') await edit('setting', 'attempted')
		await clickButton('Save')
		expect(submitted).toHaveBeenCalledWith({ setting: 'original' })
	},
)

it('restores record row order together with values on reset', async () => {
	const fields = extractFormFields(v.object({ labels: v.record(v.string(), v.string()) }))
	await mount({ labels: { alpha: 'first', beta: 'second' } }, fields)
	const valueOrder = () =>
		[...container.querySelectorAll<HTMLInputElement>('input[name^="labels."]')].map(
			(element) => element.name,
		)
	await clickButton('上移', 1)
	expect(valueOrder()).toEqual(['labels.beta', 'labels.alpha'])
	await clickButton('Reset')
	expect(valueOrder()).toEqual(['labels.alpha', 'labels.beta'])
})

it('initializes union selection for deep fields and native array edits while retaining leaf metadata', async () => {
	const fields = extractFormFields(
		v.object({
			connection: v.variant('type', [
				v.object({
					type: v.literal('local'),
					details: v.object({ host: v.string() }),
					servers: v.array(v.object({ host: v.string() })),
				}),
				v.object({ type: v.literal('remote'), url: v.string() }),
			]),
		}),
	)
	const union = fields[0]!
	if (union.kind !== 'union') throw new Error('Expected union')
	const servers = union.branches[0]!.fields.find((field) => field.key === 'servers')!.node
	if (servers.kind !== 'array') throw new Error('Expected array')
	servers.addLabel = 'Add server'
	servers.defaultItem = { host: 'new' }
	await mount({ connection: {} }, fields)
	expect(ctx.form.state.isDirty).toBe(false)
	await edit('connection.details.host', 'nested')
	expect(ctx.form.state.values).toEqual({
		connection: { type: 'local', details: { host: 'nested' } },
	})
	expect(ctx.form.getFieldMeta('connection.details.host')?.isDirty).toBe(true)
	await clickButton('Reset')
	expect(ctx.form.state.values).toEqual({ connection: {} })
	expect(ctx.form.state.isDirty).toBe(false)
	await clickButton('Add server')
	expect(ctx.form.state.values).toEqual({
		connection: { type: 'local', servers: [{ host: 'new' }] },
	})
})

it('composes initialization of nested union selections on the first leaf edit', async () => {
	const fields = extractFormFields(
		v.object({
			connection: v.variant('type', [
				v.object({
					type: v.literal('local'),
					transport: v.variant('mode', [
						v.object({ mode: v.literal('socket'), host: v.string() }),
						v.object({ mode: v.literal('file'), file: v.string() }),
					]),
				}),
				v.object({ type: v.literal('remote'), url: v.string() }),
			]),
		}),
	)
	const submitted = await mount({ connection: { transport: {} } }, fields)
	await edit('connection.transport.host', 'nested')
	expect(ctx.form.getFieldMeta('connection.transport.host')?.isDirty).toBe(true)
	await clickButton('Save')
	expect(submitted).toHaveBeenCalledWith({
		connection: { type: 'local', transport: { mode: 'socket', host: 'nested' } },
	})
})

it('isolates object and array edits from sibling field renderers', async () => {
	await mount(defaults())
	const renders = vi.mocked(FieldRenderer)
	renders.mockClear()
	await edit('database.host', 'updated')
	expect(renders.mock.calls.length).toBeLessThanOrEqual(2)
	expect(renders.mock.calls.map(([props]) => props.path.join('.'))).toContain('database.host')
	expect(
		renders.mock.calls.every(([props]) =>
			['database', 'database.host'].includes(props.path.join('.')),
		),
	).toBe(true)
	renders.mockClear()
	await edit('servers[1].host', 'updated')
	expect(renders.mock.calls.length).toBeLessThanOrEqual(2)
	expect(renders.mock.calls.map(([props]) => props.path.join('.'))).toContain('servers.1.host')
	expect(
		renders.mock.calls.every(([props]) =>
			['servers.1', 'servers.1.host'].includes(props.path.join('.')),
		),
	).toBe(true)
})

it('isolates union and record edits from sibling field renderers', async () => {
	const fields = extractFormFields(
		v.object({
			connection: v.pipe(
				v.variant('type', [
					v.object({ type: v.literal('local'), file: v.string(), user: v.string() }),
					v.object({ type: v.literal('remote'), url: v.string() }),
				]),
				unionMeta({ control: 'radio' }),
			),
			labels: v.record(v.string(), v.string()),
		}),
	)
	await mount(
		{ connection: { type: 'local', file: 'a', user: 'b' }, labels: { a: 'a', b: 'b', c: 'c' } },
		fields,
	)
	const renders = vi.mocked(FieldRenderer)
	renders.mockClear()
	await edit('connection.file', 'changed')
	expect(renders.mock.calls.length).toBeLessThanOrEqual(2)
	expect(renders.mock.calls.map(([props]) => props.path.join('.'))).toContain('connection.file')
	expect(
		renders.mock.calls.every(([props]) =>
			['connection', 'connection.file'].includes(props.path.join('.')),
		),
	).toBe(true)
	renders.mockClear()
	await edit('labels.a', 'changed')
	expect(renders.mock.calls.length).toBeLessThanOrEqual(2)
	expect(renders.mock.calls.map(([props]) => props.path.join('.'))).toContain('labels.a')
	expect(
		renders.mock.calls.every(([props]) => ['labels', 'labels.a'].includes(props.path.join('.'))),
	).toBe(true)
})

it('invalidates only the atomic ancestor server issue when editing a literal record key', async () => {
	const fields = extractFormFields(
		v.object({ labels: v.record(v.string(), v.string()), title: v.string() }),
	)
	await mount({ labels: { 'x.y': 'old' }, title: 'title' }, fields)
	await act(async () =>
		ctx.form.setErrorMap({
			onServer: { fields: { labels: 'Record rejected', title: 'Title rejected' } },
		} as never),
	)
	const control = [...container.querySelectorAll<HTMLInputElement>('input')].find(
		(el) => el.value === 'old',
	)!
	await editElement(control, 'fixed')
	expect(ctx.form.getFieldMeta('labels')?.errors).toEqual([])
	expect(ctx.form.getFieldMeta('title')?.errors).toContain('Title rejected')
})

it.each([false, true])(
	'associates picker array errors with its focusable input (create=%s)',
	async (create) => {
		const fields = extractFormFields(v.object({ tags: v.array(v.picklist(['alpha', 'beta'])) }))
		const node = fields[0]!
		if (node.kind !== 'array' || node.item?.kind !== 'picklist')
			throw new Error('Expected picker array')
		node.layout = 'picker'
		node.item.searchable = true
		node.item.create = create
		await mount({ tags: ['alpha'] }, fields)
		await act(async () =>
			ctx.form.setErrorMap({ onServer: { fields: { tags: 'Tags rejected' } } } as never),
		)
		const control = container.querySelector<HTMLInputElement>('input:not([type="hidden"])')!
		expect(control.getAttribute('aria-invalid')).toBe('true')
		const errorId = control.getAttribute('aria-describedby')!
		expect(errorId).toBeTruthy()
		expect(document.getElementById(errorId)?.textContent).toBe('Tags rejected')
		expect(container.textContent?.match(/Tags rejected/g)).toHaveLength(1)
		await clickButton('Reset')
		expect(control.getAttribute('aria-describedby')).toBeNull()
	},
)

it('renders select option descriptions and accepts a real dropdown selection', async () => {
	const fields = extractFormFields(v.object({ role: v.picklist(['reader', 'writer']) }))
	const node = fields[0]!
	if (node.kind !== 'picklist') throw new Error('Expected picklist')
	node.entries = [
		{ value: 'reader', label: 'Reader', description: 'Read access' },
		{ value: 'writer', label: 'Writer', description: 'Write access' },
	]
	await mount({ role: 'reader' }, fields)
	const control = container.querySelector<HTMLInputElement>('input:not([type="hidden"])')!
	await act(async () => control.click())
	expect(document.body.textContent).toContain('Write access')
	const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((el) =>
		el.textContent?.includes('Write access'),
	)!
	expect(option).toBeDefined()
	await act(async () => option.click())
	expect(ctx.form.state.values.role).toBe('writer')
})

it.each(['删除', '上移', '添加Servers'])(
	'invalidates an array structural error on %s',
	async (operation) => {
		await mount(defaults())
		await act(async () =>
			ctx.form.setErrorMap({
				onServer: { fields: { servers: 'Array rejected', 'database.user': 'User rejected' } },
			} as never),
		)
		await clickButton(operation, operation === '添加Servers' ? 0 : 1)
		expect(ctx.form.getFieldMeta('servers')?.errors).toEqual([])
		expect(ctx.form.getFieldMeta('database.user')?.errors).toContain('User rejected')
	},
)

it.each(['select', 'radio', 'segmented'] as const)(
	'associates union selector errors (%s)',
	async (control) => {
		const fields = extractFormFields(
			v.object({
				connection: v.pipe(
					v.variant('type', [
						v.object({ type: v.literal('local'), file: v.string() }),
						v.object({ type: v.literal('remote'), url: v.string() }),
					]),
					unionMeta({ control }),
				),
			}),
		)
		await mount({ connection: { type: 'local', file: 'a' } }, fields)
		await act(async () =>
			ctx.form.setErrorMap({
				onServer: { fields: { connection: 'Connection rejected' } },
			} as never),
		)
		const selector = container.querySelector<HTMLElement>(
			'[aria-invalid="true"][aria-describedby]',
		)!
		expect(selector).not.toBeNull()
		expect(
			document.getElementById(selector.getAttribute('aria-describedby')!)?.textContent,
		).toContain('Connection rejected')
	},
)
