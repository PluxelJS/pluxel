import { getValues } from '@modular-forms/react'
// DebugValues.tsx
import { useSignalEffect } from '@preact/signals-react'
import { useState } from 'react'

export function DebugValues({ form }: { form: any }) {
	const [, forceUpdate] = useState({})
	useSignalEffect(() => {
		// 每次读取 getValues 就会订阅内部信号
		getValues(form)
		forceUpdate({})
	})

	return (
		<pre
			style={{
				marginTop: 16,
				background: '#f5f5f5',
				padding: 12,
				borderRadius: 4,
			}}
		>
			<code>{JSON.stringify(getValues(form), null, 2)}</code>
		</pre>
	)
}
