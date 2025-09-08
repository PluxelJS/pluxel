// src/index.ts（关键片段）
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { BasePlugin, Config, Plugin, v } from "@pluxel/hmr";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import * as s from "./db/schema";

const CfgSchema = v.object({
	url: v.optional(v.string(), "file:./data/local.db"),
	authToken: v.optional(v.string()),
	migrationMode: v.optional(
		v.picklist(["off", "verify", "apply"]),
		process.env.NODE_ENV === "production" ? "verify" : "apply",
	),
	migrationsFolder: v.optional(v.string(), "drizzle"),
});
type Cfg = Config<typeof CfgSchema>;
export type Db = LibSQLDatabase<typeof s.schema>;

@Plugin({ name: "sqlite" })
export class Sqlite extends BasePlugin {
	@Config(CfgSchema) private config!: Cfg;
	public client!: Client;
	public db!: Db;
	public schema = s.schema;

	async init(_abort: AbortSignal): Promise<void> {
		const { url, authToken, migrationMode, migrationsFolder } =
			this.config;

		this.client = createClient({ url, authToken });
		this.db = drizzle(this.client, { schema: this.schema });

		// 统一解析迁移目录（绝对路径，避免 monorepo cwd 混乱）
		const folderAbs = isAbsolute(migrationsFolder)
			? migrationsFolder
			: resolve(process.cwd(), migrationsFolder);
		const journal = join(folderAbs, "meta/_journal.json");

		if (migrationMode === "apply") {
			if (!existsSync(journal)) {
				this.ctx.logger.warn(
					`migrationMode=apply 但缺少 ${journal}；请先跑 drizzle-kit generate，或切换为 'verify'/'off'。`,
				);
			} else {
				const { migrate } = await import("drizzle-orm/libsql/migrator");
				await migrate(this.db, { migrationsFolder: folderAbs });
				this.ctx.logger.info(`migrations applied from: ${folderAbs}`);
			}
		} else if (migrationMode === "verify") {
			// 轻量“版本/表结构探针”：挑一张关键表做存在性/查询校验
			// 没表会抛错，给出明确引导（而不是启动后运行期才炸）
			try {
				// 任意一个关键表；若首次部署可用 pragma/自建 meta 表替代
				await this.db
					.select({ id: s.schema.users.id })
					.from(s.schema.users)
					.limit(1);
			} catch (e) {
				const hint = existsSync(journal)
					? `请执行迁移：drizzle-kit migrate（或在 CI 里跑 scripts/migrate.ts）。`
					: `找不到迁移元数据 ${journal}；请先 drizzle-kit generate，再执行迁移。`;
				throw new Error(`数据库 schema 未就绪。${hint}`);
			}
		}
		this.ctx.logger.info("Sqlite initialized");
	}

	async stop(_abort: AbortSignal): Promise<void> {
		try {
			await this.client.close?.();
		} finally {
			this.ctx.logger.info("Sqlite stopped");
		}
	}
}
export default Sqlite;
