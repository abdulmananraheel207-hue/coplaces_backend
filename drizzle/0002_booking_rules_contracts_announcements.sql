CREATE TABLE `announcements` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`draft` integer DEFAULT true NOT NULL,
	`publish_at` text,
	`created_by_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `announcements_location_idx` ON `announcements` (`location_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `contracts` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`member_id` text NOT NULL,
	`resource_id` text,
	`assignment_id` text,
	`start_date` text NOT NULL,
	`end_date` text,
	`rent_cents` integer DEFAULT 0 NOT NULL,
	`deposit_cents` integer DEFAULT 0 NOT NULL,
	`deposit_status` text DEFAULT 'pending' NOT NULL,
	`deposit_returned_cents` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_by_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `contracts_location_idx` ON `contracts` (`location_id`,`status`);--> statement-breakpoint
CREATE INDEX `contracts_member_idx` ON `contracts` (`member_id`);--> statement-breakpoint
CREATE TABLE `location_holidays` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`date` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `location_holidays_idx` ON `location_holidays` (`location_id`,`date`);--> statement-breakpoint
ALTER TABLE `locations` ADD `closed_weekdays` text DEFAULT '' NOT NULL;