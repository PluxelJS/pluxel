// src/db/schema.ts

import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	// SQLite 没 DATETIME；用 epoch 毫秒最稳，TS 映射为 number
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.notNull()
		.default(sql`(unixepoch('subsecond')*1000)`),
});

export const schema = { users }; // 统一导出给 drizzle 用
