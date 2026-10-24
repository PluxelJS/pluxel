import { createFileRoute } from '@tanstack/react-router'
import { HomeIntro } from '../../home/HomeIntro'

export const Route = createFileRoute('/_workbench/')({
	staticData: { worksplit: { title: '首页' } },
	component: HomeIntro,
})
