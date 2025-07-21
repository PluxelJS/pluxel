// DebugValues.tsx
import { useState } from 'react'

export function DebugValues({ formValues }: { formValues: any }) {
	return (
		<pre
			style={{
				marginTop: 16,
				background: '#f5f5f5',
				padding: 12,
				borderRadius: 4,
			}}
		>
			<code>{JSON.stringify(formValues, null, 2)}</code>
		</pre>
	)
}
