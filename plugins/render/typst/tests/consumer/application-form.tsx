import {
	useRef,
	useState,
	useSyncExternalStore,
	type ChangeEvent,
	type FocusEvent,
	type KeyboardEvent,
} from 'react'
import type { TypstSourceProject } from '@pluxel/plugin-typst/source/browser'

const path = 'data/application.json'
const encoder = new TextEncoder()
type Field = { key: string; label: string; input?: 'textarea' | 'date' | 'choice' }
const applicantFields: readonly Field[] = [
	{ key: 'name', label: '姓名' },
	{ key: 'studentId', label: '学号' },
	{ key: 'applicationType', label: '申请类型', input: 'choice' },
	{ key: 'reason', label: '申请理由', input: 'textarea' },
	{ key: 'signature', label: '申请人签字' },
	{ key: 'date', label: '日期', input: 'date' },
]
const opinion: Field = { key: 'opinion', label: '审批意见', input: 'textarea' }
const choices = [
	{ value: 'new', label: '新申请' },
	{ value: 'renew', label: '续期' },
	{ value: 'change', label: '变更' },
] as const
type Draft = { text: string; base: string; source: string; revision: number }

/** Host-owned form controls use the same ordinary JSON file and project history as the editor. */
export function ApplicationForm({
	project,
	hasPending,
	onIssue,
}: {
	project: TypstSourceProject
	hasPending: boolean
	onIssue(message: string): void
}) {
	const revision = useSyncExternalStore(project.subscribe, () => project.revision)
	const contents = project.snapshot().files[path]
	const source = typeof contents === 'string' ? contents : new TextDecoder().decode(contents)
	let data: Record<string, string>
	try {
		data = JSON.parse(source)
		if (!data || Array.isArray(data) || typeof data !== 'object')
			throw new Error('需要 JSON 对象。')
		for (const field of [...applicantFields, opinion])
			if (typeof data[field.key] !== 'string') throw new Error(`${field.label}需要字符串值。`)
	} catch (error) {
		return (
			<p role="alert" className="application-error">
				无法读取填报数据：{String(error)}。请打开源码检查。
			</p>
		)
	}
	const input = (field: Field) => (
		<ApplicationField
			key={field.key}
			field={field}
			value={data[field.key]!}
			source={source}
			revision={revision}
			project={project}
		/>
	)
	return (
		<section className="application-form" aria-label="申请填报">
			<div className="application-toolbar">
				<p>离开输入框后更新预览；Enter 确认单行输入，Esc 放弃当前输入。</p>
				<div className="application-history">
					<button
						type="button"
						disabled={!project.canUndo && !hasPending}
						onClick={() => {
							if (document.querySelector('.application-form [data-typst-unapplied]')) return
							if (!project.canUndo) return
							const result = project.undo()
							if (!result.ok) onIssue(result.issues.map((issue) => issue.message).join('\n'))
						}}
					>
						撤销填报
					</button>
					<button
						type="button"
						disabled={!project.canRedo || hasPending}
						onClick={() => {
							const result = project.redo()
							if (!result.ok) onIssue(result.issues.map((issue) => issue.message).join('\n'))
						}}
					>
						重做填报
					</button>
				</div>
			</div>
			<fieldset className="application-grid">
				<legend>申请信息</legend>
				{applicantFields.map(input)}
			</fieldset>
			<fieldset className="application-grid">
				<legend>审批信息</legend>
				{input(opinion)}
			</fieldset>
		</section>
	)
}

function ApplicationField({
	field,
	value,
	source,
	revision,
	project,
}: {
	field: Field
	value: string
	source: string
	revision: number
	project: TypstSourceProject
}) {
	const [draft, setDraft] = useState<Draft | null>(null)
	const [error, setError] = useState('')
	const composing = useRef(false)
	const writable = project.isWritable(path)
	const cancel = () => {
		setDraft(null)
		setError('')
	}
	const apply = (text: string, captured = draft) => {
		if (!captured || !writable) return
		if (text === captured.base) {
			cancel()
			return
		}
		try {
			const data = JSON.parse(captured.source)
			data[field.key] = text
			const result = project.apply({
				baseRevision: captured.revision,
				patches: [
					{
						path,
						from: 0,
						to: encoder.encode(captured.source).length,
						text: JSON.stringify(data, null, 2) + '\n',
					},
				],
			})
			if (!result.ok) {
				setError(result.issues.map((issue) => issue.message).join('\n'))
				return
			}
			cancel()
		} catch (cause) {
			setError(String(cause))
		}
	}
	const control = {
		'aria-label': field.label,
		value: draft?.text ?? value,
		disabled: !writable,
		onChange(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) {
			const text = event.currentTarget.value
			setDraft((current) => ({ ...(current ?? { base: value, source, revision }), text }))
			setError('')
		},
		onBlur(event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) {
			apply(event.currentTarget.value)
		},
		onCompositionStart() {
			composing.current = true
		},
		onCompositionEnd() {
			composing.current = false
		},
		onKeyDown(event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
			if (event.nativeEvent.isComposing || composing.current) return
			if (event.key === 'Escape') {
				event.preventDefault()
				cancel()
			} else if (event.key === 'Enter' && field.input !== 'textarea') {
				event.preventDefault()
				event.currentTarget.blur()
			}
		},
	}
	return (
		<div
			className={`application-field${field.input === 'textarea' || field.input === 'choice' ? ' application-wide' : ''}`}
			data-typst-unapplied={(draft && draft.text !== draft.base) || undefined}
		>
			{field.input === 'choice' ? (
				<fieldset className="application-choices">
					<legend>{field.label}</legend>
					{choices.map((choice) => (
						<label key={choice.value}>
							<input
								type="radio"
								name="applicationType"
								value={choice.value}
								disabled={!writable}
								checked={value === choice.value}
								onChange={() =>
									apply(choice.value, { text: choice.value, base: value, source, revision })
								}
							/>
							{choice.label}
						</label>
					))}
				</fieldset>
			) : (
				<label>
					<span>{field.label}</span>
					{field.input === 'textarea' ? (
						<textarea rows={field.key === 'reason' ? 6 : 4} {...control} />
					) : (
						<input type={field.input === 'date' ? 'date' : 'text'} {...control} />
					)}
				</label>
			)}
			{error && (
				<p role="alert" className="application-error">
					{error}（Esc 放弃当前输入）
				</p>
			)}
		</div>
	)
}
