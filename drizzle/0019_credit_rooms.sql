CREATE TABLE `member_credit_resources` (
	`member_id` text NOT NULL,
	`resource_id` text NOT NULL,
	PRIMARY KEY(`member_id`, `resource_id`),
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `resources` ADD `credits_allowed` integer DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE `resources` SET `credits_allowed` = 1 WHERE `kind` = 'room';
--> statement-breakpoint
INSERT INTO `member_credit_resources` (`member_id`, `resource_id`) SELECT m.`id`, r.`id` FROM `members` m JOIN `resources` r ON r.`location_id` = m.`location_id` AND r.`kind` = 'room' WHERE m.`meeting_credits` > 0;
