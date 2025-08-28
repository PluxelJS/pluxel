// DebugValues.tsx
import { useState } from 'react'

export function DebugValues({ formValues }: { formValues: any }) {
	return (
		<pre
			style={{
				borderRadius: 4,
			}}
		>
			<code>{JSON.stringify(formValues, null, 2)}</code>
		</pre>
	)
}
