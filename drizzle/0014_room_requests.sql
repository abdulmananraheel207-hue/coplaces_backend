CREATE TABLE `room_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`member_id` text NOT NULL,
	`date` text NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`decided_by_id` text,
	`decided_at` text,
	`booking_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `room_requests_location_idx` ON `room_requests` (`location_id`,`status`);--> statement-breakpoint
CREATE INDEX `room_requests_resource_idx` ON `room_requests` (`resource_id`,`date`);--> statement-breakpoint
CREATE INDEX `room_requests_member_idx` ON `room_requests` (`member_id`);