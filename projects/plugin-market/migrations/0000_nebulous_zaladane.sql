CREATE TABLE `audits` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`action` text NOT NULL,
	`revision` integer,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_package` ON `audits` (`name`,`at`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`version` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`next_attempt_at` integer,
	`lease_token` text,
	`lease_until` integer,
	`code` text,
	`diagnostic` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_coordinate` ON `notifications` (`name`,`version`);--> statement-breakpoint
CREATE INDEX `notification_schedule` ON `notifications` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `notification_retention` ON `notifications` (`updated_at`);--> statement-breakpoint
CREATE TABLE `packages` (
	`name` text PRIMARY KEY NOT NULL,
	`description` text,
	`dist_tags` text NOT NULL,
	`observed_at` integer NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `releases` (
	`name` text NOT NULL,
	`version` text NOT NULL,
	`tarball` text NOT NULL,
	`integrity` text NOT NULL,
	`checked_at` integer NOT NULL,
	`provenance` text NOT NULL,
	`peer_dependencies` text NOT NULL,
	`plugin_packages` text NOT NULL,
	PRIMARY KEY(`name`, `version`),
	FOREIGN KEY (`name`) REFERENCES `packages`(`name`) ON UPDATE no action ON DELETE no action
);
