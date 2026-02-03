import { describe, expect, test } from 'vitest'
import { checkPluginDecorator, getPluginInfo } from '@pluxel/core'

import GraphQLPluginDefault, { GraphQLPlugin } from './index'

describe('@pluxel/graphql', () => {
	test('exports a decorated plugin ctor (default export)', () => {
		expect(GraphQLPluginDefault).toBe(GraphQLPlugin)
		expect(checkPluginDecorator(GraphQLPlugin)).toBe(true)
		expect(getPluginInfo(GraphQLPlugin).declaredName).toBe('GraphQL')
	})
})
