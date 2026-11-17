CREATE TABLE `edits` (
	`id` text PRIMARY KEY NOT NULL,
	`record_id` text NOT NULL,
	`revision` integer NOT NULL,
	`actor` text NOT NULL,
	FOREIGN KEY (`record_id`) REFERENCES `registrations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`registry` text NOT NULL,
	`package_name` text NOT NULL,
	`version` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`lease_token` text,
	`lease_until` integer,
	`diagnostic` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_coordinate` ON `notifications` (`registry`,`package_name`,`version`);--> statement-breakpoint
CREATE TABLE `registrations` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL
);
