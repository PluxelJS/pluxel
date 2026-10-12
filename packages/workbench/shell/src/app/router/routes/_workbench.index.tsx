import { createFileRoute } from '@tanstack/react-router'
import { HomeScreen } from '../screens/HomeScreen'

export const Route = createFileRoute('/_workbench/')({
	staticData: { worksplit: { title: '首页' } },
	component: HomeScreen,
})
