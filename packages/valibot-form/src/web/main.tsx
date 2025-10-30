import { MantineProvider } from '@mantine/core'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { Home } from './demo/App'
import '@mantine/core/styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
	<React.StrictMode>
		<MantineProvider>
			<Home />
		</MantineProvider>
	</React.StrictMode>,
)
