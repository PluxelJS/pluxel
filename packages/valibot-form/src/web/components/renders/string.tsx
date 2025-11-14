import {
	ActionIcon,
	ColorInput,
	Text,
	TextInput,
	Textarea,
} from '@mantine/core'
import { IconCheck, IconCopy } from '@tabler/icons-react'
import { useCallback, useMemo, useState } from 'react'
import { DEFAULT_TEXTS } from '~/core/constants'
import type { CommonProps } from '~/core/registry'
import { registerRenderer, triggerFormEvents } from '~/core/registry'
import { META_MAP } from '~/core/utils'
import { FieldChrome } from '../shared'
import { cleanProps, getEventValue } from '../../utils/propHelpers'

type RendererProps = CommonProps<typeof META_MAP.STRING> & { value?: unknown }

function StringField(props: RendererProps) {
	const { formBaseInfo, errors, extractedPropsInfo, inputProps, value } = props
	const [copied, setCopied] = useState(false)

	const errorMessages = useMemo(() =>
		(errors ?? []).map((err) => err.message),
		[errors]
	)

	const currentValue = value == null ? '' : typeof value === 'string' ? value : String(value)
	const mode = extractedPropsInfo.mode ?? (extractedPropsInfo.secret ? 'password' : 'single')

	const handleCopy = useCallback(() => {
		if (!extractedPropsInfo.copyable || !currentValue || typeof navigator === 'undefined') return
		navigator.clipboard
			.writeText(currentValue)
			.then(() => {
				setCopied(true)
				setTimeout(() => setCopied(false), 1200)
			})
			.catch(() => setCopied(false))
	}, [currentValue, extractedPropsInfo.copyable])

	// 构建左右装饰
	const leftSection = extractedPropsInfo.prefix ? (
		<Text size="sm" c="dimmed">{extractedPropsInfo.prefix}</Text>
	) : undefined

	const rightSection = (extractedPropsInfo.suffix || extractedPropsInfo.copyable) ? (
		<div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
			{extractedPropsInfo.suffix && (
				<Text size="sm" c="dimmed">{extractedPropsInfo.suffix}</Text>
			)}
			{extractedPropsInfo.copyable && (mode === 'single' || mode === 'password') && (
				<ActionIcon
					size="sm"
					variant="subtle"
					onClick={handleCopy}
					aria-label="复制字段值"
					disabled={!currentValue || (inputProps.readOnly ?? false)}
				>
					{copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
				</ActionIcon>
			)}
		</div>
	) : undefined

	// 渲染控件
	let control: React.ReactNode

	if (extractedPropsInfo.format === 'hex_color') {
		control = (
			<ColorInput
				value={currentValue}
				onChange={(val) => triggerFormEvents(inputProps, val)}
				withPicker={!(inputProps.readOnly ?? false)}
				{...cleanProps({ disabled: inputProps.disabled })}
			/>
		)
	} else if (mode === 'textarea' || mode === 'code') {
		control = (
			<Textarea
				value={currentValue}
				onChange={(e) => triggerFormEvents(inputProps, getEventValue(e))}
				autosize={extractedPropsInfo.autoGrow}
				minRows={extractedPropsInfo.rows ?? 3}
				maxRows={extractedPropsInfo.autoGrow ? 12 : undefined}
				{...cleanProps({
					disabled: inputProps.disabled,
					readOnly: inputProps.readOnly,
					placeholder: extractedPropsInfo.placeholder,
				})}
				styles={mode === 'code' ? {
					input: { fontFamily: 'var(--mantine-font-family-monospace)' },
				} : undefined}
			/>
		)
	} else {
		control = (
			<TextInput
				value={currentValue}
				onChange={(e) => triggerFormEvents(inputProps, getEventValue(e))}
				type={mode === 'password' ? 'password' : 'text'}
				leftSection={leftSection}
				rightSection={rightSection}
				{...cleanProps({
					placeholder: extractedPropsInfo.placeholder,
					disabled: inputProps.disabled,
					readOnly: inputProps.readOnly,
				})}
			/>
		)
	}

	return (
		<FieldChrome
			{...cleanProps({
				label: formBaseInfo.label,
				required: formBaseInfo.required,
				description: formBaseInfo.description,
				helperText: formBaseInfo.helperText,
				hint: formBaseInfo.hint ?? extractedPropsInfo.note,
				tooltip: formBaseInfo.tooltip,
				badge: formBaseInfo.badge,
				errors: errorMessages,
			})}
		>
			{control}
		</FieldChrome>
	)
}

registerRenderer(META_MAP.STRING, (props: any) => <StringField {...props} />)
