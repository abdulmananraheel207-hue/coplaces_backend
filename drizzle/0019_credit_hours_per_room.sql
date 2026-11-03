ALTER TABLE `member_credit_resources` ADD `credits` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `member_credit_resources` SET `credits` = (SELECT `meeting_credits` FROM `members` WHERE `members`.`id` = `member_credit_resources`.`member_id`);
