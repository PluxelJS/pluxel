import * as v from 'valibot'
import * as f from 'valibot-form'
import { workbench } from '@pluxel/workbench'
import type { BotDetailApi, BotWorkspaceApi } from './BotWorkspace.contracts'

const Sources = v.array(
	v.object({
		label: v.pipe(v.string(), f.formMeta({ title: '来源' })),
		available: v.pipe(v.boolean(), f.formMeta({ title: '在线' })),
		count: v.pipe(v.number(), f.formMeta({ title: '机器人数量' })),
	}),
)
const Events = v.array(
	v.object({
		source: v.pipe(v.string(), f.formMeta({ title: '来源' })),
		bot: v.pipe(v.string(), f.formMeta({ title: '机器人' })),
		at: v.pipe(v.string(), f.formMeta({ title: '时间' })),
		message: v.pipe(v.string(), f.formMeta({ title: '事件' })),
	}),
)

export const BotWorkspaceWorkbench = workbench.define(import.meta.url, {
	home: workbench.view<BotWorkspaceApi>({
		renderer: './ui/home.tsx',
		placement: {
			kind: 'route',
			path: '/bot-lab',
			title: '机器人工作区',
			navigation: { label: '机器人工作区（模拟）' },
			order: 2,
		},
	}),
	list: workbench.view<BotWorkspaceApi>({
		renderer: './ui/list.tsx',
		placement: {
			kind: 'panel',
			region: 'left',
			label: '机器人',
			icon: 'message-chatbot',
		},
	}),
	bot: workbench.view<BotDetailApi>({
		renderer: './ui/bot.tsx',
		placement: { kind: 'route', path: '/bot-lab/:source/:bot', title: '机器人' },
	}),
	sources: workbench.content({
		document: './sources.md',
		slots: {
			sources: workbench.data(Sources),
		},
		placement: { kind: 'panel', region: 'right', label: '数据来源' },
	}),
	events: workbench.content({
		document: './events.md',
		slots: {
			events: workbench.data(Events),
		},
		placement: { kind: 'panel', region: 'bottom', label: '工作区事件' },
	}),
})
