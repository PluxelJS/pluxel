import { Center } from '@mantine/core'
import { ErrorState } from '../../../components'

export function RouteErrorScreen({ error }: { error: unknown }) {
	const message =
		error instanceof Error ? error.message : typeof error === 'string' ? error : '未知错误'
	return (
		<Center style={{ flex: 1 }}>
			<ErrorState title="页面发生错误" message={message} minHeight={240} />
		</Center>
	)
}
