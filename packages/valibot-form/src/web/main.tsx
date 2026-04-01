import { MantineProvider } from '@mantine/core'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { DemoApp } from './demo/DemoApp'
import '@mantine/core/styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
	<React.StrictMode>
		<MantineProvider>
			<DemoApp />
		</MantineProvider>
	</React.StrictMode>,
)
