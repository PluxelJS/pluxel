import { application } from '@pluxel/rolldown/build'

export default application({
	entry: './src/app.ts',
	variant: 'workbench',
	target: 'node',
})
