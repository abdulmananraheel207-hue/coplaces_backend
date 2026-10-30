CREATE TABLE `member_desks` (
	`member_id` text NOT NULL,
	`resource_id` text NOT NULL,
	PRIMARY KEY(`member_id`, `resource_id`),
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `member_shifts` (
	`member_id` text NOT NULL,
	`shift_id` text NOT NULL,
	PRIMARY KEY(`member_id`, `shift_id`),
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`shift_id`) REFERENCES `shift_templates`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `bookings` ADD `source` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `members` ADD `plan_start` text;--> statement-breakpoint
ALTER TABLE `members` ADD `plan_end` text;