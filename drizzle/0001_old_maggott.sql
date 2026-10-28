CREATE TABLE `floor_objects` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`floor` text DEFAULT '' NOT NULL,
	`type` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`x` real NOT NULL,
	`z` real NOT NULL,
	`w` real,
	`d` real,
	`rot` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `floor_objects_location_idx` ON `floor_objects` (`location_id`);--> statement-breakpoint
ALTER TABLE `resources` ADD `style` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `resources` ADD `plan_x` real;--> statement-breakpoint
ALTER TABLE `resources` ADD `plan_z` real;--> statement-breakpoint
ALTER TABLE `resources` ADD `plan_w` real;--> statement-breakpoint
ALTER TABLE `resources` ADD `plan_d` real;--> statement-breakpoint
ALTER TABLE `resources` ADD `plan_rot` integer DEFAULT 0 NOT NULL;