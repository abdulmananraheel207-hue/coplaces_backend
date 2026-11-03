ALTER TABLE `deposit_entries` ADD `status` text DEFAULT 'cleared' NOT NULL;--> statement-breakpoint
ALTER TABLE `deposit_entries` ADD `cleared_at` text;--> statement-breakpoint
ALTER TABLE `deposit_entries` ADD `bounced_at` text;--> statement-breakpoint
ALTER TABLE `expenses` ADD `method` text DEFAULT 'cash' NOT NULL;--> statement-breakpoint
ALTER TABLE `expenses` ADD `reference` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `payments` ADD `status` text DEFAULT 'cleared' NOT NULL;--> statement-breakpoint
ALTER TABLE `payments` ADD `cleared_at` text;--> statement-breakpoint
ALTER TABLE `payments` ADD `bounced_at` text;--> statement-breakpoint
UPDATE `payments` SET `method` = 'bank_transfer' WHERE `method` IN ('jazzcash', 'easypaisa');--> statement-breakpoint
UPDATE `payments` SET `method` = 'cash' WHERE `method` NOT IN ('cash', 'card', 'bank_transfer', 'cheque');--> statement-breakpoint
UPDATE `deposit_entries` SET `method` = 'bank_transfer' WHERE `method` IN ('jazzcash', 'easypaisa');--> statement-breakpoint
UPDATE `deposit_entries` SET `method` = 'cash' WHERE `method` IS NOT NULL AND `method` NOT IN ('cash', 'card', 'bank_transfer', 'cheque');--> statement-breakpoint
UPDATE `platform_payments` SET `method` = 'bank_transfer' WHERE `method` IN ('jazzcash', 'easypaisa');--> statement-breakpoint
UPDATE `platform_payments` SET `method` = 'cash' WHERE `method` NOT IN ('cash', 'card', 'bank_transfer', 'cheque');--> statement-breakpoint
UPDATE `payments` SET `cleared_at` = `paid_at` WHERE `status` = 'cleared';--> statement-breakpoint
UPDATE `deposit_entries` SET `cleared_at` = `occurred_at` WHERE `status` = 'cleared';
