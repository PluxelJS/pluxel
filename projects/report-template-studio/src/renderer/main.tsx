import { createRoot } from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import { App } from './app'
import { connectDesktop } from './api'
import '@mantine/core/styles.css'
import '@worksplit/react/style.css'
import 'flexlayout-react/style/light.css'
import './style.css'

await connectDesktop()
createRoot(document.getElementById('root')!).render(
	<MantineProvider
		theme={{
			primaryColor: 'teal',
			defaultRadius: 'md',
			fontFamily: 'Inter, system-ui, sans-serif',
		}}
	>
		<App />
	</MantineProvider>,
)
