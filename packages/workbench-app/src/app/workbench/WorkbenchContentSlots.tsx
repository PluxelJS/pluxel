import { Alert, Button, Group, Loader, Modal, Stack, Text } from '@mantine/core'
import { formOptions } from '@tanstack/react-form'
import type {
	WorkbenchContentActionOutcome,
	WorkbenchContentActionPresentation,
	WorkbenchContentDataPresentation,
	WorkbenchContentPresentation,
} from '@pluxel/runtime/workbench/client'
import type {
	WorkbenchConfirmInput,
	WorkbenchNotificationInput,
} from '@pluxel/runtime/workbench/federation'
import type { ConfigPresentationFieldV1, RuntimeJsonValue } from '@pluxel/runtime/web'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AutoForm, useAutoFormCtx } from 'valibot-form/web'
import type {
	WorkbenchContentController,
	WorkbenchContentDataState,
} from './WorkbenchContentController'
import { adaptConfigPresentationFields } from './presentationAdapter'
import {
	mapServerValidationIssues,
	mountedFieldNames,
	ServerValidationSummary,
} from '../forms/serverValidation'

const MAX_VISIBLE_ITEMS = 100
const MAX_INLINE_TEXT = 256
const MAX_BLOCK_TEXT = 4_096

export type WorkbenchContentInteraction = Readonly<{
	presentation: WorkbenchContentPresentation
	controller: WorkbenchContentController
	confirm(input: WorkbenchConfirmInput): Promise<boolean>
	notify(input: WorkbenchNotificationInput): void
}>

export function WorkbenchContentSlot({
	slotKey,
	display,
	interaction,
	state,
}: {
	slotKey: string
	display: 'inline' | 'block'
	interaction: WorkbenchContentInteraction | null
	state: WorkbenchContentDataState
}): ReactNode {
	const slot = interaction?.presentation.slots.find((candidate) => candidate.key === slotKey)
	if (!interaction || !slot) {
		return display === 'inline' ? (
			<span className="plx-workbenchContent__slotUnavailable">暂不可用</span>
		) : (
			<Alert color="gray" variant="light">
				此内容暂不可用。
			</Alert>
		)
	}
	if (slot.kind === 'data') {
		return <ContentDataSlot slot={slot} state={state} retry={interaction.controller.retry} />
	}
	return <ContentActionSlot interaction={interaction} slot={slot} />
}

function ContentDataSlot({
	slot,
	state,
	retry,
}: {
	slot: WorkbenchContentDataPresentation
	state: WorkbenchContentDataState
	retry(): Promise<void>
}) {
	if (slot.display === 'inline') {
		if (state.status === 'loading') {
			return (
				<span className="plx-workbenchContent__inlineStatus" role="status">
					<Loader size={12} /> 加载中…
				</span>
			)
		}
		if (state.status === 'error') {
			return (
				<span className="plx-workbenchContent__inlineStatus" role="alert">
					数据不可用
					<button
						aria-label={`重试加载${fieldLabel(slot.field)}`}
						disabled={state.refreshing}
						onClick={() => void retry()}
						type="button"
					>
						重试
					</button>
				</span>
			)
		}
		return (
			<span
				className="plx-workbenchContent__inlineValue"
				data-stale={state.stale || undefined}
				title={state.stale ? (state.message ?? '数据可能已过期') : undefined}
			>
				{formatInlineValue(slot.field, state.data?.[slot.key])}
				{state.stale ? (
					<span className="plx-workbenchContent__staleMark">（可能已过期）</span>
				) : null}
			</span>
		)
	}

	return (
		<section className="plx-workbenchContent__dataSlot" aria-label={fieldLabel(slot.field)}>
			{state.status === 'loading' ? (
				<div className="plx-workbenchContent__slotLoading" role="status">
					<Loader size="sm" /> 正在加载数据…
				</div>
			) : null}
			{state.status === 'error' ? (
				<Alert color="red" title="数据加载失败" variant="light">
					<Stack gap="xs">
						<Text size="sm">{state.message}</Text>
						<Button
							aria-label={`重试加载${fieldLabel(slot.field)}`}
							loading={state.refreshing}
							onClick={() => void retry()}
							size="xs"
							variant="light"
						>
							重试
						</Button>
					</Stack>
				</Alert>
			) : null}
			{state.status === 'ready' ? (
				<>
					{state.stale ? (
						<Alert color="yellow" title="显示的是上次数据" variant="light">
							<Group gap="sm" justify="space-between">
								<Text size="sm">{state.message}</Text>
								<Button
									aria-label={`重试加载${fieldLabel(slot.field)}`}
									loading={state.refreshing}
									onClick={() => void retry()}
									size="xs"
									variant="subtle"
								>
									重试
								</Button>
							</Group>
						</Alert>
					) : null}
					<div className="plx-workbenchContent__dataCard">
						<div className="plx-workbenchContent__dataHeader">
							<strong>{fieldLabel(slot.field)}</strong>
							{slot.field.meta.description ? <span>{slot.field.meta.description}</span> : null}
						</div>
						<PortableValue field={slot.field} value={state.data?.[slot.key]} />
					</div>
				</>
			) : null}
		</section>
	)
}

function PortableValue({
	field,
	value,
	depth = 0,
}: {
	field: ConfigPresentationFieldV1 | null | undefined
	value: RuntimeJsonValue | undefined
	depth?: number
}): ReactNode {
	if (value === undefined || value === null)
		return <span className="plx-workbenchContent__empty">—</span>
	if (depth >= 8) return <span className="plx-workbenchContent__empty">内容层级过深</span>
	if (!field) return <GenericPortableValue value={value} depth={depth} />

	switch (field.kind) {
		case 'string': {
			if (typeof value !== 'string') {
				return <GenericPortableValue value={value} depth={depth} />
			}
			return (
				<span className="plx-workbenchContent__scalar">
					{field.control === 'password' ? '••••••••' : boundedText(value, MAX_BLOCK_TEXT)}
				</span>
			)
		}
		case 'number':
			return typeof value === 'number' ? (
				<span className="plx-workbenchContent__scalar">{value}</span>
			) : (
				<GenericPortableValue value={value} depth={depth} />
			)
		case 'boolean':
			if (typeof value !== 'boolean') {
				return <GenericPortableValue value={value} depth={depth} />
			}
			return <span className="plx-workbenchContent__scalar">{value ? '是' : '否'}</span>
		case 'picklist':
			return <span className="plx-workbenchContent__scalar">{picklistLabel(field, value)}</span>
		case 'array': {
			if (!Array.isArray(value)) return <GenericPortableValue value={value} depth={depth} />
			if (value.length === 0) return <span className="plx-workbenchContent__empty">暂无项目</span>
			const visible = value.slice(0, MAX_VISIBLE_ITEMS)
			return (
				<ol className="plx-workbenchContent__dataList">
					{visible.map((item, index) => (
						<li key={index}>
							<PortableValue depth={depth + 1} field={field.item} value={item} />
						</li>
					))}
					{value.length > visible.length ? (
						<li className="plx-workbenchContent__empty">另有 {value.length - visible.length} 项</li>
					) : null}
				</ol>
			)
		}
		case 'record': {
			const record = portableRecord(value)
			if (!record) return <GenericPortableValue value={value} depth={depth} />
			return (
				<PortableRecord
					depth={depth}
					emptyLabel="暂无记录"
					record={record}
					valueField={field.value}
				/>
			)
		}
		case 'object': {
			const record = portableRecord(value)
			if (!record) return <GenericPortableValue value={value} depth={depth} />
			const visible = field.fields.filter((child) => child.name && !child.meta.hidden)
			if (visible.length === 0) return <span className="plx-workbenchContent__empty">暂无字段</span>
			return (
				<dl className="plx-workbenchContent__dataGrid">
					{visible.map((child) => (
						<div key={child.name}>
							<dt>{fieldLabel(child)}</dt>
							<dd>
								<PortableValue depth={depth + 1} field={child} value={record[child.name!]} />
							</dd>
						</div>
					))}
				</dl>
			)
		}
		case 'union': {
			const record = portableRecord(value)
			if (!record) return <GenericPortableValue value={value} depth={depth} />
			const discriminatorValue = field.discriminator ? record[field.discriminator] : undefined
			const branch = field.branches.find(
				(candidate) => candidate.discriminatorValue === discriminatorValue,
			)
			const projected = [
				...field.sharedFields,
				...(field.discriminatorField ? [field.discriminatorField] : []),
				...(branch?.fields ?? []),
			]
			if (projected.length === 0) return <GenericPortableValue value={value} depth={depth} />
			return (
				<dl className="plx-workbenchContent__dataGrid">
					{projected.map((child) => (
						<div key={child.key}>
							<dt>{fieldLabel(child.node)}</dt>
							<dd>
								<PortableValue depth={depth + 1} field={child.node} value={record[child.key]} />
							</dd>
						</div>
					))}
				</dl>
			)
		}
		case 'unsupported':
			return <span className="plx-workbenchContent__empty">此值无法安全显示</span>
	}
}

function PortableRecord({
	record,
	valueField,
	depth,
	emptyLabel,
}: {
	record: Readonly<Record<string, RuntimeJsonValue>>
	valueField: ConfigPresentationFieldV1 | null | undefined
	depth: number
	emptyLabel: string
}) {
	const entries = Object.entries(record)
	if (entries.length === 0) return <span className="plx-workbenchContent__empty">{emptyLabel}</span>
	const visible = entries.slice(0, MAX_VISIBLE_ITEMS)
	return (
		<dl className="plx-workbenchContent__dataGrid">
			{visible.map(([key, entry]) => (
				<div key={key}>
					<dt>{key}</dt>
					<dd>
						<PortableValue depth={depth + 1} field={valueField} value={entry} />
					</dd>
				</div>
			))}
			{entries.length > visible.length ? (
				<div>
					<dt>更多</dt>
					<dd>另有 {entries.length - visible.length} 项</dd>
				</div>
			) : null}
		</dl>
	)
}

function GenericPortableValue({
	value,
	depth,
}: {
	value: RuntimeJsonValue
	depth: number
}): ReactNode {
	if (depth >= 8) return <span className="plx-workbenchContent__empty">内容层级过深</span>
	if (typeof value === 'string') return boundedText(value, MAX_BLOCK_TEXT)
	if (typeof value === 'number' || typeof value === 'boolean') return String(value)
	if (value === null) return <span className="plx-workbenchContent__empty">—</span>
	if (Array.isArray(value)) {
		return (
			<ol className="plx-workbenchContent__dataList">
				{value.slice(0, MAX_VISIBLE_ITEMS).map((item, index) => (
					<li key={index}>
						<GenericPortableValue depth={depth + 1} value={item} />
					</li>
				))}
			</ol>
		)
	}
	return (
		<PortableRecord
			depth={depth}
			emptyLabel="暂无字段"
			record={portableRecord(value)!}
			valueField={undefined}
		/>
	)
}

function ContentActionSlot({
	slot,
	interaction,
}: {
	slot: WorkbenchContentActionPresentation
	interaction: WorkbenchContentInteraction
}) {
	const [dialogOpen, setDialogOpen] = useState(false)
	const [dialogGeneration, setDialogGeneration] = useState(0)
	const execution = useActionExecution(slot, interaction)
	const closeDialog = useCallback(() => {
		setDialogOpen(false)
		setDialogGeneration((value) => value + 1)
	}, [])
	const requestDialogClose = useCallback(() => {
		if (!execution.pending) closeDialog()
	}, [closeDialog, execution.pending])

	if (slot.input === 'none') {
		return (
			<div className="plx-workbenchContent__actionSlot">
				<Button
					color={slot.confirm ? 'red' : undefined}
					loading={execution.pending}
					onClick={() => void execution.run()}
				>
					{slot.label}
				</Button>
				<ActionFeedback feedback={execution.feedback} />
			</div>
		)
	}

	if (slot.input === 'embedded') {
		return (
			<div className="plx-workbenchContent__actionSlot plx-workbenchContent__actionForm">
				<ContentActionForm execution={execution} slot={slot} />
			</div>
		)
	}

	return (
		<div className="plx-workbenchContent__actionSlot">
			<Button color={slot.confirm ? 'red' : undefined} onClick={() => setDialogOpen(true)}>
				{slot.label}
			</Button>
			<ActionFeedback feedback={execution.feedback} />
			<Modal
				centered
				closeOnClickOutside={!execution.pending}
				closeOnEscape={!execution.pending}
				onClose={requestDialogClose}
				opened={dialogOpen}
				size="lg"
				title={slot.label}
				withCloseButton={!execution.pending}
			>
				{dialogOpen ? (
					<ContentActionForm
						execution={execution}
						key={dialogGeneration}
						onCancel={requestDialogClose}
						onSuccess={closeDialog}
						slot={slot}
					/>
				) : null}
			</Modal>
		</div>
	)
}

type ActionFeedback = Readonly<{ tone: 'success' | 'error'; message: string }> | null

type ActionExecution = Readonly<{
	pending: boolean
	feedback: ActionFeedback
	run(rawInput?: unknown): Promise<WorkbenchContentActionOutcome | null>
}>

function useActionExecution(
	slot: WorkbenchContentActionPresentation,
	interaction: WorkbenchContentInteraction,
): ActionExecution {
	const mounted = useRef(true)
	const running = useRef(false)
	const [pending, setPending] = useState(false)
	const [feedback, setFeedback] = useState<ActionFeedback>(null)
	useEffect(() => {
		mounted.current = true
		return () => {
			mounted.current = false
		}
	}, [])

	const run = useCallback(
		async (rawInput?: unknown): Promise<WorkbenchContentActionOutcome | null> => {
			if (!mounted.current || running.current) return null
			running.current = true
			setPending(true)
			setFeedback(null)
			try {
				if (slot.confirm) {
					const confirmed = await interaction.confirm({
						title: slot.label,
						message: slot.confirm,
						confirmLabel: slot.label,
						cancelLabel: '取消',
						tone: 'danger',
					})
					if (!confirmed || !mounted.current) return null
				}
				const outcome = await interaction.controller.run(slot.key, rawInput)
				if (!mounted.current) return null
				if (outcome.ok === true) {
					const message = outcome.message ?? '操作已完成。'
					setFeedback({ tone: 'success', message })
					if (outcome.message) {
						try {
							interaction.notify({ title: slot.label, message: outcome.message, tone: 'success' })
						} catch {
							// Inline feedback is authoritative; a host notification is best effort.
						}
					}
					return outcome
				}
				setFeedback({ tone: 'error', message: actionFailureMessage(outcome) })
				return outcome
			} catch {
				if (!mounted.current) return null
				setFeedback({ tone: 'error', message: '操作失败，请重试。' })
				return null
			} finally {
				running.current = false
				if (mounted.current) setPending(false)
			}
		},
		[interaction, slot],
	)

	return useMemo(() => ({ pending, feedback, run }), [feedback, pending, run])
}

function ContentActionForm({
	slot,
	execution,
	onCancel,
	onSuccess,
}: {
	slot: WorkbenchContentActionPresentation
	execution: ActionExecution
	onCancel?: () => void
	onSuccess?: () => void
}) {
	const fields = useMemo(() => adaptConfigPresentationFields(slot.fields ?? []), [slot.fields])
	const opts = useMemo(
		() =>
			formOptions({
				defaultValues: {} as Record<string, unknown>,
				canSubmitWhenInvalid: true,
				listeners: {
					onChange: ({ formApi }) => {
						formApi.setErrorMap({ onServer: undefined })
					},
				},
				onSubmit: async ({ value, formApi }) => {
					formApi.setErrorMap({ onServer: { fields: {} } } as never)
					const outcome = await execution.run(value)
					if (!outcome || formApi.state.values !== value) return
					if (outcome.ok === true) {
						formApi.reset({})
						onSuccess?.()
						return
					}
					if (outcome.code === 'validation_failed') {
						formApi.setErrorMap({
							onServer: mapServerValidationIssues(outcome.issues, mountedFieldNames(formApi)),
						} as never)
					}
				},
			}),
		[execution, onSuccess],
	)

	return (
		<AutoForm fields={fields} formOpts={opts} formProps={{ 'aria-label': `${slot.label}表单` }}>
			<Stack gap="md">
				<AutoForm.Fields sectionSpacing="md" />
				<ServerValidationSummary />
				<ActionFeedback feedback={execution.feedback} />
				<ContentActionFormButtons onCancel={onCancel} slot={slot} />
			</Stack>
		</AutoForm>
	)
}

function ContentActionFormButtons({
	slot,
	onCancel,
}: {
	slot: WorkbenchContentActionPresentation
	onCancel?: () => void
}) {
	const { form, submit } = useAutoFormCtx()
	return (
		<AutoForm.Actions>
			{({ submitting }) => (
				<Group justify="flex-end">
					{onCancel ? (
						<Button disabled={submitting} onClick={onCancel} type="button" variant="default">
							取消
						</Button>
					) : null}
					<Button
						color={slot.confirm ? 'red' : undefined}
						loading={submitting}
						onClick={() => {
							form.setErrorMap({ onServer: { fields: {} } } as never)
							submit()
						}}
						type="button"
					>
						{slot.label}
					</Button>
				</Group>
			)}
		</AutoForm.Actions>
	)
}

function ActionFeedback({ feedback }: { feedback: ActionFeedback }) {
	if (!feedback) return null
	return (
		<Text
			aria-live={feedback.tone === 'error' ? 'assertive' : 'polite'}
			className="plx-workbenchContent__actionFeedback"
			c={feedback.tone === 'error' ? 'red' : 'green'}
			role={feedback.tone === 'error' ? 'alert' : 'status'}
			size="sm"
		>
			{feedback.message}
		</Text>
	)
}

function actionFailureMessage(
	outcome: Exclude<WorkbenchContentActionOutcome, { ok: true }>,
): string {
	switch (outcome.code) {
		case 'rejected':
			return outcome.message
		case 'validation_failed':
			return '请检查表单中的内容。'
		case 'busy':
			return '操作正在进行，请稍后重试。'
		case 'unknown_action':
			return '此操作已不可用，请重新打开内容。'
		case 'invalid_input':
			return '提交的数据无效。'
		case 'action_failed':
			return '操作失败，请重试。'
	}
}

function formatInlineValue(
	field: ConfigPresentationFieldV1,
	value: RuntimeJsonValue | undefined,
): string {
	if (value === undefined || value === null) return '—'
	if (field.kind === 'string' && field.control === 'password') return '••••••••'
	if (field.kind === 'boolean') return value ? '是' : '否'
	if (field.kind === 'picklist') return picklistLabel(field, value)
	if (typeof value === 'string') return boundedText(value, MAX_INLINE_TEXT)
	if (typeof value === 'number' || typeof value === 'boolean') return String(value)
	if (Array.isArray(value)) return `${value.length} 项`
	return `${Object.keys(value as Readonly<Record<string, RuntimeJsonValue>>).length} 个字段`
}

function picklistLabel(
	field: Extract<ConfigPresentationFieldV1, { kind: 'picklist' }>,
	value: RuntimeJsonValue,
): string {
	if (Array.isArray(value)) return value.map((item) => picklistLabel(field, item)).join('、')
	if (typeof value !== 'string' && typeof value !== 'number') return '—'
	const entry = field.entries?.find((candidate) => candidate.value === value)
	return entry?.label ?? field.labels?.[String(value)] ?? String(value)
}

function fieldLabel(field: ConfigPresentationFieldV1): string {
	return field.meta.label || field.name || '数据'
}

function boundedText(value: string, maximum: number): string {
	return value.length <= maximum ? value : `${value.slice(0, maximum)}…`
}

function portableRecord(
	value: RuntimeJsonValue,
): Readonly<Record<string, RuntimeJsonValue>> | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	return value as Readonly<Record<string, RuntimeJsonValue>>
}
