CREATE TABLE `floor_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`data` text NOT NULL,
	`created_by_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `floor_templates_org_name_idx` ON `floor_templates` (`organization_id`,`name`);--> statement-breakpoint
CREATE TABLE `issues` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`reported_by_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`resolution` text DEFAULT '' NOT NULL,
	`task_id` text,
	`created_at` text NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reported_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `issues_location_idx` ON `issues` (`location_id`,`status`);--> statement-breakpoint
CREATE INDEX `issues_resource_idx` ON `issues` (`resource_id`);--> statement-breakpoint
CREATE INDEX `issues_reporter_idx` ON `issues` (`reported_by_id`);--> statement-breakpoint
CREATE TABLE `resource_photos` (
	`id` text PRIMARY KEY NOT NULL,
	`resource_id` text NOT NULL,
	`content_type` text NOT NULL,
	`data` blob NOT NULL,
	`caption` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `resource_photos_resource_idx` ON `resource_photos` (`resource_id`);--> statement-breakpoint
CREATE TABLE `space_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`resource_id` text,
	`name` text NOT NULL,
	`category` text DEFAULT '' NOT NULL,
	`serial_number` text DEFAULT '' NOT NULL,
	`purchased_on` text,
	`warranty_until` text,
	`status` text DEFAULT 'working' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `space_assets_location_idx` ON `space_assets` (`location_id`);--> statement-breakpoint
CREATE INDEX `space_assets_resource_idx` ON `space_assets` (`resource_id`);--> statement-breakpoint
CREATE TABLE `space_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`resource_id` text,
	`kind` text DEFAULT 'cleaning' NOT NULL,
	`title` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`every_days` integer,
	`next_due` text NOT NULL,
	`last_done_at` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `space_tasks_location_idx` ON `space_tasks` (`location_id`,`active`,`next_due`);--> statement-breakpoint
CREATE INDEX `space_tasks_resource_idx` ON `space_tasks` (`resource_id`);--> statement-breakpoint
CREATE TABLE `task_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`done_at` text NOT NULL,
	`done_by_id` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `space_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`done_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `task_logs_task_idx` ON `task_logs` (`task_id`);--> statement-breakpoint
ALTER TABLE `floor_objects` ADD `variant` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `floor_objects` ADD `tint` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `resources` ADD `description` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `resources` ADD `open_time` text;--> statement-breakpoint
ALTER TABLE `resources` ADD `close_time` text;--> statement-breakpoint
ALTER TABLE `resources` ADD `closed_weekdays` text;--> statement-breakpoint
ALTER TABLE `resources` ADD `off_peak_rate_cents` integer;--> statement-breakpoint
ALTER TABLE `resources` ADD `peak_start` text;--> statement-breakpoint
ALTER TABLE `resources` ADD `peak_end` text;--> statement-breakpoint
ALTER TABLE `resources` ADD `half_day_rate_cents` integer;--> statement-breakpoint
ALTER TABLE `resources` ADD `full_day_rate_cents` integer;--> statement-breakpoint
ALTER TABLE `resources` ADD `no_plan_rate_cents` integer;