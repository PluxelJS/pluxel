import type { TypstComponentParametersProps } from '@pluxel/plugin-typst/tiptap/react'

/** This consumer supplies a local form for its own ordinary Typst component. */
export function renderComponentParameters({
	component,
	values,
	disabled,
	onChange,
}: TypstComponentParametersProps) {
	if (component.module !== 'components/blocks.typ' || component.name !== 'metrics') return
	return (
		<fieldset className="metrics-parameters" disabled={disabled}>
			<legend className="sr-only">指标卡设置</legend>
			<label>
				标题
				<input
					aria-label="指标卡标题"
					placeholder="组件默认"
					value={String(values.title ?? '')}
					onChange={(event) => onChange({ ...values, title: event.currentTarget.value })}
				/>
			</label>
			<label>
				底色
				<select
					aria-label="指标卡底色"
					value={String(values.accent ?? '')}
					onChange={(event) => {
						const next = { ...values }
						if (event.currentTarget.value) next.accent = event.currentTarget.value
						else delete next.accent
						onChange(next)
					}}
				>
					<option value="">组件默认</option>
					<option value="#eef4fa">雾蓝</option>
					<option value="#effaf3">浅绿</option>
					<option value="#fff7e5">暖黄</option>
					{values.accent && !['#eef4fa', '#effaf3', '#fff7e5'].includes(String(values.accent)) && (
						<option value={String(values.accent)}>自定义：{String(values.accent)}</option>
					)}
				</select>
			</label>
			<p>标题与底色只影响这张指标卡；业务数据由所有引用共享。</p>
		</fieldset>
	)
}
