CREATE TABLE `amenities` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`name` text NOT NULL,
	`price_cents` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `amenities_location_idx` ON `amenities` (`location_id`);--> statement-breakpoint
CREATE TABLE `amenity_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`member_id` text NOT NULL,
	`amenity_id` text NOT NULL,
	`name` text NOT NULL,
	`date` text NOT NULL,
	`quantity` integer NOT NULL,
	`free_quantity` integer NOT NULL,
	`charge_cents` integer NOT NULL,
	`collected_at` text,
	`recorded_by_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`amenity_id`) REFERENCES `amenities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recorded_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `amenity_orders_member_idx` ON `amenity_orders` (`member_id`,`date`);--> statement-breakpoint
CREATE INDEX `amenity_orders_location_idx` ON `amenity_orders` (`location_id`,`date`);--> statement-breakpoint
CREATE TABLE `member_amenities` (
	`member_id` text NOT NULL,
	`amenity_id` text NOT NULL,
	`free_per_day` integer NOT NULL,
	PRIMARY KEY(`member_id`, `amenity_id`),
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`amenity_id`) REFERENCES `amenities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `members` ADD `meeting_credits` integer DEFAULT 0 NOT NULL;