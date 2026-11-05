DROP INDEX `audit_package`;--> statement-breakpoint
ALTER TABLE `audits` ADD `registry` text DEFAULT 'https://registry.npmjs.org' NOT NULL;--> statement-breakpoint
ALTER TABLE `audits` ADD `changes` text;--> statement-breakpoint
CREATE INDEX `audit_package` ON `audits` (`registry`,`name`,`at`);--> statement-breakpoint
DROP INDEX `notification_coordinate`;--> statement-breakpoint
ALTER TABLE `notifications` ADD `registry` text DEFAULT 'https://registry.npmjs.org' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `notification_coordinate` ON `notifications` (`registry`,`name`,`version`);--> statement-breakpoint
CREATE TABLE `__new_packages` (
	`registry` text DEFAULT 'https://registry.npmjs.org' NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`dist_tags` text NOT NULL,
	`observed_at` integer NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`official` integer DEFAULT false NOT NULL,
	`category` text,
	`tags` text DEFAULT '[]' NOT NULL,
	PRIMARY KEY(`registry`, `name`)
);
--> statement-breakpoint
-- Existing records came from the only previously supported source: public npm.
INSERT INTO `__new_packages`("name", "description", "dist_tags", "observed_at", "hidden", "revision") SELECT "name", "description", "dist_tags", "observed_at", "hidden", "revision" FROM `packages`;--> statement-breakpoint
CREATE TABLE `__new_releases` (
	`registry` text DEFAULT 'https://registry.npmjs.org' NOT NULL,
	`name` text NOT NULL,
	`version` text NOT NULL,
	`tarball` text NOT NULL,
	`integrity` text NOT NULL,
	`checked_at` integer NOT NULL,
	`provenance` text NOT NULL,
	`peer_dependencies` text NOT NULL,
	`plugin_packages` text NOT NULL,
	PRIMARY KEY(`registry`, `name`, `version`),
	FOREIGN KEY (`registry`,`name`) REFERENCES `__new_packages`(`registry`,`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_releases`("name", "version", "tarball", "integrity", "checked_at", "provenance", "peer_dependencies", "plugin_packages") SELECT "name", "version", "tarball", "integrity", "checked_at", "provenance", "peer_dependencies", "plugin_packages" FROM `releases`;--> statement-breakpoint
DROP TABLE `releases`;--> statement-breakpoint
DROP TABLE `packages`;--> statement-breakpoint
ALTER TABLE `__new_packages` RENAME TO `packages`;--> statement-breakpoint
ALTER TABLE `__new_releases` RENAME TO `releases`;--> statement-breakpoint
CREATE INDEX `package_browse` ON `packages` (`hidden`,`name`,`registry`);--> statement-breakpoint
CREATE INDEX `package_category` ON `packages` (`category`,`official`);
