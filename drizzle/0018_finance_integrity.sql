CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text,
	`location_id` text,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`amount_cents` integer,
	`data` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_log_location_idx` ON `audit_log` (`location_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_log_entity_idx` ON `audit_log` (`entity`,`entity_id`);--> statement-breakpoint
ALTER TABLE `contracts` ADD `advance_used_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `invoice_items` ADD `category` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `invoice_items` ADD `resource_id` text;--> statement-breakpoint
ALTER TABLE `invoice_items` ADD `plan_id` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `tax_rate_bps` integer;--> statement-breakpoint
ALTER TABLE `invoices` ADD `contract_id` text;--> statement-breakpoint
CREATE INDEX `invoices_contract_idx` ON `invoices` (`contract_id`,`period_start`);--> statement-breakpoint
ALTER TABLE `members` ADD `credit_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `members` ADD `credit_used_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payments` ADD `reverses_payment_id` text;--> statement-breakpoint
ALTER TABLE `payments` ADD `reversed_at` text;--> statement-breakpoint
ALTER TABLE `payments` ADD `reversed_by_id` text;--> statement-breakpoint
UPDATE `invoices` SET `tax_rate_bps` = (SELECT `tax_rate_bps` FROM `locations` WHERE `locations`.`id` = `invoices`.`location_id`) WHERE `tax_rate_bps` IS NULL;--> statement-breakpoint
UPDATE `invoice_items` SET `category` = 'booking' WHERE `booking_id` IS NOT NULL;--> statement-breakpoint
UPDATE `invoice_items` SET `category` = 'advance' WHERE `amount_cents` < 0;--> statement-breakpoint
UPDATE `invoice_items` SET `category` = 'amenity' WHERE `category` = 'manual' AND EXISTS (SELECT 1 FROM `amenity_orders` `o` WHERE `o`.`invoice_id` = `invoice_items`.`invoice_id` AND `invoice_items`.`description` = `o`.`name` || ', ' || `o`.`date`);--> statement-breakpoint
UPDATE `invoice_items` SET `category` = 'rent' WHERE `category` = 'manual' AND EXISTS (SELECT 1 FROM `invoices` `i` JOIN `contracts` `c` ON `c`.`member_id` = `i`.`member_id` AND `c`.`company_name` != '' WHERE `i`.`id` = `invoice_items`.`invoice_id` AND `invoice_items`.`description` LIKE `c`.`company_name` || ': %');--> statement-breakpoint
UPDATE `invoice_items` SET `category` = 'plan' WHERE `category` = 'manual' AND EXISTS (SELECT 1 FROM `invoices` `i` WHERE `i`.`id` = `invoice_items`.`invoice_id` AND `i`.`kind` = 'subscription');--> statement-breakpoint
UPDATE `invoices` SET `contract_id` = (SELECT `c`.`id` FROM `contracts` `c` JOIN `invoice_items` `l` ON `l`.`invoice_id` = `invoices`.`id` WHERE `c`.`member_id` = `invoices`.`member_id` AND `c`.`company_name` != '' AND `l`.`category` = 'rent' LIMIT 1) WHERE `kind` = 'subscription' AND `contract_id` IS NULL;
