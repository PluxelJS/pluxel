CREATE TABLE `catalog_snapshot_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`scope` text,
	`etag` text
);
--> statement-breakpoint
INSERT INTO catalog_snapshot_state (id) VALUES (1);
--> statement-breakpoint
CREATE TRIGGER packages_snapshot_insert AFTER INSERT ON packages BEGIN
	UPDATE catalog_snapshot_state SET revision = revision + 1, scope = NULL, etag = NULL WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER packages_snapshot_update AFTER UPDATE ON packages BEGIN
	UPDATE catalog_snapshot_state SET revision = revision + 1, scope = NULL, etag = NULL WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER packages_snapshot_delete AFTER DELETE ON packages BEGIN
	UPDATE catalog_snapshot_state SET revision = revision + 1, scope = NULL, etag = NULL WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER releases_snapshot_insert AFTER INSERT ON releases BEGIN
	UPDATE catalog_snapshot_state SET revision = revision + 1, scope = NULL, etag = NULL WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER releases_snapshot_update AFTER UPDATE ON releases BEGIN
	UPDATE catalog_snapshot_state SET revision = revision + 1, scope = NULL, etag = NULL WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER releases_snapshot_delete AFTER DELETE ON releases BEGIN
	UPDATE catalog_snapshot_state SET revision = revision + 1, scope = NULL, etag = NULL WHERE id = 1;
END;
