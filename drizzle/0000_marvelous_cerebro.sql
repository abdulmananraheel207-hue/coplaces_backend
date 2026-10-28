CREATE TABLE `attendance` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`member_id` text NOT NULL,
	`resource_id` text,
	`check_in_at` text NOT NULL,
	`check_out_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `attendance_location_idx` ON `attendance` (`location_id`,`check_in_at`);--> statement-breakpoint
CREATE INDEX `attendance_member_idx` ON `attendance` (`member_id`);--> statement-breakpoint
CREATE TABLE `bookings` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`member_id` text NOT NULL,
	`starts_at` text NOT NULL,
	`ends_at` text NOT NULL,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`billable_minutes` integer DEFAULT 0 NOT NULL,
	`price_cents` integer DEFAULT 0 NOT NULL,
	`invoice_id` text,
	`notes` text DEFAULT '' NOT NULL,
	`created_by_id` text NOT NULL,
	`cancelled_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `bookings_resource_idx` ON `bookings` (`resource_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `bookings_member_idx` ON `bookings` (`member_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `bookings_location_idx` ON `bookings` (`location_id`,`starts_at`);--> statement-breakpoint
CREATE TABLE `expenses` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`category` text NOT NULL,
	`vendor` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`amount_cents` integer NOT NULL,
	`incurred_on` text NOT NULL,
	`created_by_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `expenses_location_idx` ON `expenses` (`location_id`,`incurred_on`);--> statement-breakpoint
CREATE TABLE `invoice_items` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`description` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`unit_price_cents` integer NOT NULL,
	`amount_cents` integer NOT NULL,
	`booking_id` text,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `invoice_items_invoice_idx` ON `invoice_items` (`invoice_id`);--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`member_id` text NOT NULL,
	`number` text NOT NULL,
	`kind` text DEFAULT 'manual' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`issue_date` text NOT NULL,
	`due_date` text NOT NULL,
	`period_start` text,
	`subtotal_cents` integer NOT NULL,
	`tax_cents` integer DEFAULT 0 NOT NULL,
	`total_cents` integer NOT NULL,
	`paid_cents` integer DEFAULT 0 NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `invoices_location_idx` ON `invoices` (`location_id`,`status`);--> statement-breakpoint
CREATE INDEX `invoices_member_idx` ON `invoices` (`member_id`);--> statement-breakpoint
CREATE INDEX `invoices_period_idx` ON `invoices` (`member_id`,`period_start`);--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_location_number_idx` ON `invoices` (`location_id`,`number`);--> statement-breakpoint
CREATE TABLE `locations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`code` text NOT NULL,
	`address` text DEFAULT '' NOT NULL,
	`timezone` text DEFAULT 'Asia/Karachi' NOT NULL,
	`currency` text DEFAULT 'PKR' NOT NULL,
	`open_time` text DEFAULT '08:00' NOT NULL,
	`close_time` text DEFAULT '20:00' NOT NULL,
	`tax_rate_bps` integer DEFAULT 0 NOT NULL,
	`invoice_seq` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `locations_org_code_idx` ON `locations` (`organization_id`,`code`);--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`location_id` text NOT NULL,
	`company` text DEFAULT '' NOT NULL,
	`plan_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `members_user_id_unique` ON `members` (`user_id`);--> statement-breakpoint
CREATE INDEX `members_location_idx` ON `members` (`location_id`,`status`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`contact_email` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`city` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'trial' NOT NULL,
	`package_id` text NOT NULL,
	`period_end` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`package_id`) REFERENCES `packages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `packages` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`interval` text DEFAULT 'month' NOT NULL,
	`price_cents` integer NOT NULL,
	`features` text DEFAULT '[]' NOT NULL,
	`max_locations` integer,
	`max_members` integer,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `packages_name_unique` ON `packages` (`name`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`member_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`method` text NOT NULL,
	`paid_at` text NOT NULL,
	`reference` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`recorded_by_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recorded_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `payments_location_idx` ON `payments` (`location_id`,`paid_at`);--> statement-breakpoint
CREATE INDEX `payments_invoice_idx` ON `payments` (`invoice_id`);--> statement-breakpoint
CREATE TABLE `plans` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`interval` text DEFAULT 'month' NOT NULL,
	`price_cents` integer NOT NULL,
	`included_meeting_minutes` integer DEFAULT 0 NOT NULL,
	`includes_hot_desk` integer DEFAULT false NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `platform_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`package_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`method` text NOT NULL,
	`reference` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`paid_at` text NOT NULL,
	`recorded_by_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`package_id`) REFERENCES `packages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recorded_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `platform_payments_org_idx` ON `platform_payments` (`organization_id`,`paid_at`);--> statement-breakpoint
CREATE TABLE `resource_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`resource_id` text NOT NULL,
	`member_id` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `assignments_resource_idx` ON `resource_assignments` (`resource_id`);--> statement-breakpoint
CREATE INDEX `assignments_member_idx` ON `resource_assignments` (`member_id`);--> statement-breakpoint
CREATE TABLE `resources` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`floor` text DEFAULT '' NOT NULL,
	`capacity` integer DEFAULT 1 NOT NULL,
	`hourly_rate_cents` integer DEFAULT 0 NOT NULL,
	`daily_rate_cents` integer DEFAULT 0 NOT NULL,
	`amenities` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'available' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `resources_location_name_idx` ON `resources` (`location_id`,`name`);--> statement-breakpoint
CREATE TABLE `user_locations` (
	`user_id` text NOT NULL,
	`location_id` text NOT NULL,
	PRIMARY KEY(`user_id`, `location_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`name` text NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`role` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`last_login_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `visitors` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`host_member_id` text NOT NULL,
	`name` text NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`company` text DEFAULT '' NOT NULL,
	`purpose` text DEFAULT '' NOT NULL,
	`expected_at` text NOT NULL,
	`status` text DEFAULT 'expected' NOT NULL,
	`check_in_at` text,
	`check_out_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`host_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `visitors_location_idx` ON `visitors` (`location_id`,`expected_at`);--> statement-breakpoint
CREATE INDEX `visitors_host_idx` ON `visitors` (`host_member_id`);