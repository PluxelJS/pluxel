import * as v from 'valibot'

const User = v.object({
	__typename: v.nullish(v.literal('User')),
	id: v.number(),
	name: v.string(),
})

interface IUser extends v.InferOutput<typeof User> {}

const Book = v.object({
	__typename: v.nullish(v.literal('Book')),
	id: v.number(),
	title: v.string(),
	authorID: v.number(),
})

interface IBook extends v.InferOutput<typeof Book> {}

import { query, resolver } from '@gqloom/core'

const _userMapp: Map<number, IUser> = new Map(
	[
		{ id: 1, name: 'Cao Xueqin' },
		{ id: 2, name: 'Wu Chengen' },
	].map((user) => [user.id, user]),
)

const bookMap: Map<number, IBook> = new Map(
	[
		{ id: 1, title: 'Dream of Red Mansions', authorID: 1 },
		{ id: 2, title: 'Journey to the West', authorID: 2 },
	].map((book) => [book.id, book]),
)

export const bookResolver = resolver.of(Book, {
	books: query(v.array(Book)).resolve(() => Array.from(bookMap.values())),
})
