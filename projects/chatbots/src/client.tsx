import { App } from '@pluxel/components'
import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

const root = document.querySelector('#root')
if (!root) throw new Error('Missing #root element')

createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
)
