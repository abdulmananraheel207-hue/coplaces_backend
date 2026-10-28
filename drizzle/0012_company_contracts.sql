CREATE TABLE `contract_people` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_id` text NOT NULL,
	`member_id` text NOT NULL,
	`desk_resource_id` text,
	`assignment_id` text,
	`join_date` text NOT NULL,
	`leave_date` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`desk_resource_id`) REFERENCES `resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `contract_people_contract_idx` ON `contract_people` (`contract_id`);--> statement-breakpoint
CREATE INDEX `contract_people_member_idx` ON `contract_people` (`member_id`);--> statement-breakpoint
CREATE TABLE `contract_spaces` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`assignment_id` text,
	FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `contract_spaces_contract_idx` ON `contract_spaces` (`contract_id`);--> statement-breakpoint
ALTER TABLE `contracts` ADD `company_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `contracts` ADD `company_email` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `contracts` ADD `company_phone` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `contracts` ADD `pricing_mode` text DEFAULT 'per_member' NOT NULL;--> statement-breakpoint
ALTER TABLE `contracts` ADD `price_per_member_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `contracts` ADD `extra_member_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `contracts` ADD `fixed_price_cents` integer DEFAULT 0 NOT NULL;