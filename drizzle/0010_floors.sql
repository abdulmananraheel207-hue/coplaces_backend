CREATE TABLE `location_floors` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `location_floors_loc_name_idx` ON `location_floors` (`location_id`,`name`);--> statement-breakpoint
ALTER TABLE `packages` ADD `max_floors` integer;