import { BasePlugin, Config, Plugin, v } from "@pluxel/hmr";
// biome-ignore lint/style/useImportType: <explanation>
import { Sqlite } from "pluxel-plugin-sqlite";

const CfgSchema = v.object({
	test: v.optional(v.boolean(), true),
});

@Plugin({ name: "giveaway" })
export class Giveaway extends BasePlugin {
	@Config(CfgSchema)
	private config!: Config<typeof CfgSchema>;

	constructor(private dbp: Sqlite) {
		super();
	}

	async init(_abort: AbortSignal): Promise<void> {
		this.ctx.logger.info("Giveaway initialized");
    const { db, schema } = this.dbp

        // 插入：UserInsert 类型自动约束
    await db.insert(schema.users).values({ name: 'Ada', email: 'ada@ex.com' })

    // 查询：返回值是 UserSelect[]
    const rows = await db.select().from(schema.users)

    // where / eq 等都带智能提示
    const one = await db.query.users.findFirst({
      where: (u, { eq }) => eq(u.email, 'ada@ex.com'),
    })

    this.ctx.logger.info({ count: rows.length, one }, 'demo ok')
	}

	async stop(_abort: AbortSignal): Promise<void> {
		this.ctx.logger.info("Giveaway stopped");
	}
}

export default Giveaway;
