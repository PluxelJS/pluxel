import { Checkbox, Switch } from '@mantine/core'
import type { CommonProps } from '~/core/registry'
import { registerRenderer, triggerFormEvents } from '~/core/registry'
import { META_MAP } from '~/core/utils'
import { cleanProps, getControlProps } from '../../utils/propHelpers'
import { FieldChrome } from '../shared'

type RendererProps = CommonProps<typeof META_MAP.BOOLEAN> & { value?: unknown }

function BooleanField(props: RendererProps) {
	const { formBaseInfo, errors, extractedPropsInfo, inputProps, value } = props
	const errorMessages = (errors ?? []).map((err) => err.message)
	const checked = Boolean(value)
	const variant = extractedPropsInfo.variant ?? 'switch'

	// 统一的控件 props
	const controlProps = {
		label: formBaseInfo.label,
		checked,
		onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
			triggerFormEvents(inputProps, event.currentTarget.checked)
		},
		...getControlProps(inputProps),
	}

	const control =
		variant === 'checkbox' ? <Checkbox {...controlProps} /> : <Switch {...controlProps} />

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
				hideLabel: true,
			})}
		>
			{control}
		</FieldChrome>
	)
}

registerRenderer(META_MAP.BOOLEAN, (props) => <BooleanField {...(props as RendererProps)} />)
