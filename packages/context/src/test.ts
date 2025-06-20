import { Context } from '.'

const ctx = new Context({ mathService: { test: '122333' } })
ctx.mathService.getConfig()
