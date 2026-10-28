CREATE TABLE `shift_spaces` (
	`shift_id` text NOT NULL,
	`resource_id` text NOT NULL,
	PRIMARY KEY(`shift_id`, `resource_id`),
	FOREIGN KEY (`shift_id`) REFERENCES `shift_templates`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `shift_templates` ADD `plan_id` text REFERENCES plans(id);