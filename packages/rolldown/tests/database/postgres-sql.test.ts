import { expect, it } from 'vitest'
import {
	scopeGeneratedPostgresSql,
	validatePostgresMigrationSql,
} from '../../src/database/postgres-sql.ts'

it('distinguishes PostgreSQL schema qualifiers from comments, literals and quoted names', async () => {
	const accepted = [
		"SELECT 'public.example', E'it\\'s pluxel_system.data', 'an ''escaped'' public.name';",
		'SELECT "public.column", "prefix""public" . x FROM "table.with.dots";',
		'/* public.notes /* nested */ pluxel_host.data */ -- public.notes',
		"DO $body$ BEGIN RAISE NOTICE 'public.thing'; END $body$;",
	].join('\n')
	await expect(validatePostgresMigrationSql(accepted, 'history.sql')).resolves.toBeUndefined()
	for (const reference of [
		'PUBLIC /* separator */ . "items"',
		'"public" -- separator\n .items',
		String.raw`U&"pub\006Cic".items`,
		`U&"pub!006Cic" UESCAPE '!' .items`,
		'pluxel_system.database_instances',
	]) {
		await expect(
			validatePostgresMigrationSql(`SELECT * FROM ${reference}`, 'history.sql'),
		).rejects.toThrow('history.sql')
	}
})

it('leaves authored SQL expressions and quoted literals untouched while scoping generated DDL', async () => {
	const rawDefault = `'open'::"public"."status"`
	const input = [
		`-- 引用 CREATE TYPE "public"."status"`,
		`CREATE TYPE "public"."status" AS ENUM('public.example');`,
		`ALTER TABLE "jobs" ALTER COLUMN "status" SET DEFAULT ${rawDefault};`,
		`SELECT $$FOREIGN KEY REFERENCES "public"."jobs"$$;`,
	].join('\r\n')
	const result = await scopeGeneratedPostgresSql(input, '0001.sql', {
		tables: {
			'public.jobs': { name: 'jobs', schema: '', columns: { status: { default: rawDefault } } },
		},
		enums: { 'public.status': { name: 'status', schema: 'public' } },
	})
	expect(result).toBe(input.replace('\r\nCREATE TYPE "public".', '\r\nCREATE TYPE '))
	await expect(validatePostgresMigrationSql(result, '0001.sql')).rejects.toThrow('public schema')
})

it('uses PG column references to distinguish table aliases from schema names', async () => {
	const sql = [
		'SELECT public.id, public.* FROM items AS public;',
		'SELECT tenant.public.id FROM tenant.public;',
		'SELECT pluxel_system.id FROM items AS pluxel_system;',
		String.raw`SELECT U&"p!0075blic" UESCAPE '!' .id FROM items AS public;`,
	].join('\n')
	await expect(validatePostgresMigrationSql(sql, 'allowed.sql')).resolves.toBeUndefined()
	for (const source of [
		'SELECT public.notes.id FROM notes;',
		'SELECT project.public.notes.id FROM notes;',
		'SELECT * FROM public.items;',
		'SELECT public.id, public.score(1) FROM items AS public;',
		'CREATE TABLE linked (id int REFERENCES public.items(id));',
	]) {
		await expect(validatePostgresMigrationSql(source, 'ref.sql')).rejects.toThrow('public schema')
	}
})
