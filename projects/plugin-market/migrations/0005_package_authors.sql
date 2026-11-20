CREATE TABLE `market_authors` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`avatar_url` text,
	`observed_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `packages` ADD `repository_author_id` text REFERENCES market_authors(id);
--> statement-breakpoint
ALTER TABLE `packages` ADD `curated_author_id` text REFERENCES market_authors(id);
