PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_deposit_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`contract_id` text,
	`member_id` text,
	`kind` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`method` text,
	`reference` text DEFAULT '' NOT NULL,
	`occurred_at` text NOT NULL,
	`recorded_by_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recorded_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_deposit_entries`("id", "location_id", "contract_id", "kind", "amount_cents", "method", "reference", "occurred_at", "recorded_by_id", "created_at") SELECT "id", "location_id", "contract_id", "kind", "amount_cents", "method", "reference", "occurred_at", "recorded_by_id", "created_at" FROM `deposit_entries`;--> statement-breakpoint
DROP TABLE `deposit_entries`;--> statement-breakpoint
ALTER TABLE `__new_deposit_entries` RENAME TO `deposit_entries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `deposit_entries_location_idx` ON `deposit_entries` (`location_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `deposit_entries_contract_idx` ON `deposit_entries` (`contract_id`);--> statement-breakpoint
CREATE INDEX `deposit_entries_member_idx` ON `deposit_entries` (`member_id`);--> statement-breakpoint
ALTER TABLE `members` ADD `advance_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `members` ADD `advance_used_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `members` ADD `advance_received_at` text;--> statement-breakpoint
ALTER TABLE `members` ADD `deposit_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `members` ADD `deposit_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `members` ADD `deposit_returned_cents` integer DEFAULT 0 NOT NULL;