CREATE TABLE `device_commands` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_id` text NOT NULL,
	`command` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`return_code` integer,
	`sent_at` text,
	`done_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `device_commands_device_idx` ON `device_commands` (`device_id`,`status`);--> statement-breakpoint
CREATE TABLE `device_punches` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`pin` text NOT NULL,
	`user_id` text,
	`punched_at` text NOT NULL,
	`state` integer,
	`verify` integer,
	`result` text NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_punches_unique_idx` ON `device_punches` (`device_id`,`pin`,`punched_at`);--> statement-breakpoint
CREATE INDEX `device_punches_user_idx` ON `device_punches` (`user_id`,`punched_at`);--> statement-breakpoint
CREATE TABLE `device_users` (
	`device_id` text NOT NULL,
	`user_id` text NOT NULL,
	`pin` text NOT NULL,
	PRIMARY KEY(`device_id`, `user_id`),
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`location_id` text NOT NULL,
	`serial_number` text NOT NULL,
	`name` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`last_seen_at` text,
	`info` text DEFAULT '' NOT NULL,
	`attlog_stamp` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_serial_number_unique` ON `devices` (`serial_number`);--> statement-breakpoint
CREATE INDEX `devices_location_idx` ON `devices` (`location_id`);--> statement-breakpoint
CREATE TABLE `staff_attendance` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`user_id` text NOT NULL,
	`check_in_at` text NOT NULL,
	`check_out_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `staff_attendance_location_idx` ON `staff_attendance` (`location_id`,`check_in_at`);--> statement-breakpoint
CREATE INDEX `staff_attendance_user_idx` ON `staff_attendance` (`user_id`);--> statement-breakpoint
ALTER TABLE `users` ADD `device_pin` text;--> statement-breakpoint
CREATE UNIQUE INDEX `users_device_pin_idx` ON `users` (`organization_id`,`device_pin`);