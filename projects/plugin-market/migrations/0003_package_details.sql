ALTER TABLE `packages` ADD `repository` text;--> statement-breakpoint
ALTER TABLE `packages` ADD `repository_stars` integer;--> statement-breakpoint
ALTER TABLE `packages` ADD `repository_observed_at` integer;--> statement-breakpoint
ALTER TABLE `releases` ADD `readme` text;--> statement-breakpoint
ALTER TABLE `releases` ADD `license` text;