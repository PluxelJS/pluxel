export const exampleTitles = {
	report: '经营报告',
	'application-form': '项目申请审批表',
} as const

export type ExampleId = keyof typeof exampleTitles
