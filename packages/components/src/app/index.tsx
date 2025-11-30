import { RouterProvider, type RouterHistory } from '@tanstack/react-router'
import { useState } from 'react'
import './bootstrap'
import { createAppRouter } from './router'

export interface AppProps {
	history?: RouterHistory
}

export function App({ history }: AppProps = {}) {
	const [router] = useState(() => createAppRouter({ history }))
	return <RouterProvider router={router} />
}
