import { Text } from '@mantine/core'
import { useParams } from 'wouter'

export const TestPath = () => {
	const params = useParams()

	return <Text>Plugin: {params.name}</Text>
}
