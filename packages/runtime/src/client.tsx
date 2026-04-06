import { App } from '../../components/src/index'
import React, { Fragment } from 'react'
import ReactDOM from 'react-dom/client'
import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'

const root = document.querySelector('#root')!
const RootContainer = process.env.NODE_ENV === 'production' ? React.StrictMode : Fragment

ReactDOM.createRoot(root).render(
	<RootContainer>
		<App />
	</RootContainer>,
)
