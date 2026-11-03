CREATE TABLE `organization_logos` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`data_url` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `organizations` ADD `logo_version` text;