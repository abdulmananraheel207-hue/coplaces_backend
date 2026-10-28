CREATE TABLE `deposit_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`contract_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`method` text,
	`reference` text DEFAULT '' NOT NULL,
	`occurred_at` text NOT NULL,
	`recorded_by_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recorded_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deposit_entries_location_idx` ON `deposit_entries` (`location_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `deposit_entries_contract_idx` ON `deposit_entries` (`contract_id`);--> statement-breakpoint
-- Deposits taken before there was a ledger: write what happened to them into it.
INSERT INTO `deposit_entries` (`id`, `location_id`, `contract_id`, `kind`, `amount_cents`, `method`, `reference`, `occurred_at`, `recorded_by_id`, `created_at`)
SELECT lower(hex(randomblob(16))), `location_id`, `id`, 'received', `deposit_cents`, 'other', 'Before the ledger', `created_at`, `created_by_id`, `created_at`
FROM `contracts` WHERE `deposit_cents` > 0 AND `deposit_status` IN ('held', 'refunded', 'forfeited');
--> statement-breakpoint
INSERT INTO `deposit_entries` (`id`, `location_id`, `contract_id`, `kind`, `amount_cents`, `method`, `reference`, `occurred_at`, `recorded_by_id`, `created_at`)
SELECT lower(hex(randomblob(16))), `location_id`, `id`, 'refunded', `deposit_returned_cents`, 'other', 'Before the ledger', `created_at`, `created_by_id`, `created_at`
FROM `contracts` WHERE `deposit_status` = 'refunded' AND `deposit_returned_cents` > 0;
--> statement-breakpoint
INSERT INTO `deposit_entries` (`id`, `location_id`, `contract_id`, `kind`, `amount_cents`, `method`, `reference`, `occurred_at`, `recorded_by_id`, `created_at`)
SELECT lower(hex(randomblob(16))), `location_id`, `id`, 'kept', `deposit_cents` - `deposit_returned_cents`, NULL, 'Before the ledger', `created_at`, `created_by_id`, `created_at`
FROM `contracts` WHERE `deposit_status` IN ('refunded', 'forfeited') AND `deposit_cents` - `deposit_returned_cents` > 0;
