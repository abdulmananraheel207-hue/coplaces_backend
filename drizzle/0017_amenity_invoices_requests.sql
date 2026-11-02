CREATE TABLE `amenity_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`member_id` text NOT NULL,
	`amenity_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`decided_by_id` text,
	`decided_at` text,
	`order_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`amenity_id`) REFERENCES `amenities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `amenity_requests_location_idx` ON `amenity_requests` (`location_id`,`status`);--> statement-breakpoint
CREATE INDEX `amenity_requests_member_idx` ON `amenity_requests` (`member_id`);--> statement-breakpoint
ALTER TABLE `amenity_orders` ADD `invoice_id` text;