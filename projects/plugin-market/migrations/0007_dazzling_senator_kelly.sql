CREATE TABLE `hosted_releases` (
	`registry` text NOT NULL,
	`name` text NOT NULL,
	`version` text NOT NULL,
	`archive_key` text NOT NULL,
	`integrity` text NOT NULL,
	`shasum` text NOT NULL,
	`manifest` text NOT NULL,
	`published_at` integer NOT NULL,
	`publisher` text NOT NULL,
	PRIMARY KEY(`registry`, `name`, `version`)
);
--> statement-breakpoint
CREATE TABLE `hosted_tags` (
	`registry` text NOT NULL,
	`name` text NOT NULL,
	`tag` text NOT NULL,
	`version` text NOT NULL,
	PRIMARY KEY(`registry`, `name`, `tag`),
	FOREIGN KEY (`registry`,`name`,`version`) REFERENCES `hosted_releases`(`registry`,`name`,`version`) ON UPDATE no action ON DELETE no action
);
