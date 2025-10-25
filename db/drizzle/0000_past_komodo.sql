-- Current sql file was generated after introspecting the database
-- If you want to run this migration please uncomment this code before executing migrations
/*
CREATE TABLE `AiBotTrend` (
	`id` int AUTO_INCREMENT NOT NULL,
	`symbol` varchar(256) NOT NULL,
	`trend` varchar(10) NOT NULL,
	`startDate` datetime NOT NULL,
	`endDate` datetime NOT NULL,
	`closePrice` varchar(256) NOT NULL,
	CONSTRAINT `AiBotTrend_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `AiBotTrend12` (
	`id` int AUTO_INCREMENT NOT NULL,
	`symbol` varchar(256) NOT NULL,
	`trend` varchar(10) NOT NULL,
	`startDate` datetime NOT NULL,
	`endDate` datetime NOT NULL,
	`closePrice` varchar(256) NOT NULL,
	CONSTRAINT `AiBotTrend12_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `AiBotTrend24` (
	`id` int AUTO_INCREMENT NOT NULL,
	`symbol` varchar(256) NOT NULL,
	`trend` varchar(10) NOT NULL,
	`startDate` datetime NOT NULL,
	`endDate` datetime NOT NULL,
	`closePrice` varchar(256) NOT NULL,
	CONSTRAINT `AiBotTrend24_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `BreakOutTrend` (
	`id` int AUTO_INCREMENT NOT NULL,
	`symbol` varchar(256) NOT NULL,
	`trend` varchar(10) NOT NULL,
	`startDate` datetime NOT NULL,
	`endDate` datetime NOT NULL,
	`closePrice` varchar(256) NOT NULL,
	`rollWindowInHours` int NOT NULL,
	CONSTRAINT `BreakOutTrend_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `BreakOutWithAfter` (
	`id` int AUTO_INCREMENT NOT NULL,
	`symbol` varchar(256) NOT NULL,
	`Trend` varchar(100),
	`startDate` datetime NOT NULL,
	`endDate` datetime NOT NULL,
	`closePrice` varchar(256) NOT NULL,
	`rollWindowInHours` int NOT NULL,
	CONSTRAINT `BreakOutWithAfter_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `CrossCheck` (
	`id` int AUTO_INCREMENT NOT NULL,
	`symbol` varchar(256) NOT NULL,
	`trend` varchar(256) NOT NULL,
	`startDate` datetime NOT NULL,
	`endDate` datetime NOT NULL,
	`closePrice` varchar(256) NOT NULL,
	`rollWindowInHours` int NOT NULL,
	`marketState` varchar(256),
	CONSTRAINT `CrossCheck_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `GrokCandleTrend` (
	`id` int AUTO_INCREMENT NOT NULL,
	`symbol` varchar(256) NOT NULL,
	`trend` varchar(10) NOT NULL,
	`startDate` datetime NOT NULL,
	`endDate` datetime NOT NULL,
	`closePrice` varchar(256) NOT NULL,
	`rollWindowInHours` int NOT NULL,
	`marketState` varchar(256),
	CONSTRAINT `GrokCandleTrend_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `GrokCopyWithMarketState` (
	`id` int AUTO_INCREMENT NOT NULL,
	`symbol` varchar(256) NOT NULL,
	`trend` varchar(10) NOT NULL,
	`startDate` datetime NOT NULL,
	`endDate` datetime NOT NULL,
	`closePrice` varchar(256) NOT NULL,
	`rollWindowInHours` int NOT NULL,
	`marketState` varchar(256),
	CONSTRAINT `GrokCopyWithMarketState_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `GrokCopyWithoutMarketState` (
	`id` int AUTO_INCREMENT NOT NULL,
	`symbol` varchar(256) NOT NULL,
	`trend` varchar(10) NOT NULL,
	`startDate` datetime NOT NULL,
	`endDate` datetime NOT NULL,
	`closePrice` varchar(256) NOT NULL,
	`rollWindowInHours` int NOT NULL,
	`marketState` varchar(256),
	CONSTRAINT `GrokCopyWithoutMarketState_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `GrokUpDownOnly` (
	`id` int AUTO_INCREMENT NOT NULL,
	`symbol` varchar(256) NOT NULL,
	`trend` varchar(10) NOT NULL,
	`startDate` datetime NOT NULL,
	`endDate` datetime NOT NULL,
	`closePrice` varchar(256) NOT NULL,
	`rollWindowInHours` int NOT NULL,
	CONSTRAINT `GrokUpDownOnly_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `NewPriceTicker` (
	`id` int AUTO_INCREMENT NOT NULL,
	`symbol` varchar(256) NOT NULL,
	`lastPrice` double NOT NULL,
	`timestamp` datetime NOT NULL,
	CONSTRAINT `NewPriceTicker_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `OrderBookTicker` (
	`id` int AUTO_INCREMENT NOT NULL,
	`symbol` varchar(256) NOT NULL,
	`askPrice` double NOT NULL,
	`bidPrice` double NOT NULL,
	`timestamp` datetime NOT NULL,
	CONSTRAINT `OrderBookTicker_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `PriceTicker` (
	`id` int AUTO_INCREMENT NOT NULL,
	`symbol` varchar(256) NOT NULL,
	`lastPrice` double NOT NULL,
	`timestamp` datetime NOT NULL,
	CONSTRAINT `PriceTicker_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `Speculation` (
	`id` int AUTO_INCREMENT NOT NULL,
	`symbol` varchar(256) NOT NULL,
	`trend` varchar(10) NOT NULL,
	`startDate` datetime NOT NULL,
	`endDate` datetime NOT NULL,
	`closePrice` varchar(256) NOT NULL,
	`rollWindowInHours` int NOT NULL,
	CONSTRAINT `Speculation_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `bitbot_entries` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`runId` varchar(256) NOT NULL,
	`entryTime` datetime NOT NULL,
	`entryAvgPrice` decimal(18,8) NOT NULL,
	`wsPriceAtEntry` decimal(18,8) NOT NULL,
	`wsTimeAtEntry` bigint NOT NULL,
	`resolveTime` datetime NOT NULL,
	`resolvePrice` decimal(18,8) NOT NULL,
	`wsPriceAtResolve` decimal(18,8) NOT NULL,
	`wsTimeAtResolve` bigint NOT NULL,
	`realizedProfit` decimal(18,8) NOT NULL,
	`positionSide` enum('long','short') NOT NULL,
	`tradeMode` enum('against','follow') NOT NULL,
	`leverage` int NOT NULL,
	`margin` decimal(18,8) NOT NULL,
	CONSTRAINT `bitbot_entries_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `AiBotTrend12_symbol` ON `AiBotTrend12` (`symbol`);--> statement-breakpoint
CREATE INDEX `AiBotTrend12_startDate` ON `AiBotTrend12` (`startDate`);--> statement-breakpoint
CREATE INDEX `AiBotTrend12_endDate` ON `AiBotTrend12` (`endDate`);--> statement-breakpoint
CREATE INDEX `AiBotTrend24_symbol` ON `AiBotTrend24` (`symbol`);--> statement-breakpoint
CREATE INDEX `AiBotTrend24_startDate` ON `AiBotTrend24` (`startDate`);--> statement-breakpoint
CREATE INDEX `AiBotTrend24_endDate` ON `AiBotTrend24` (`endDate`);--> statement-breakpoint
CREATE INDEX `breakOutTrend_endDate` ON `BreakOutTrend` (`endDate`);--> statement-breakpoint
CREATE INDEX `breakOutTrend_RollWindowInHours` ON `BreakOutTrend` (`rollWindowInHours`);--> statement-breakpoint
CREATE INDEX `breakOutTrend_startDate` ON `BreakOutTrend` (`startDate`);--> statement-breakpoint
CREATE INDEX `breakOutTrend_symbol` ON `BreakOutTrend` (`symbol`);--> statement-breakpoint
CREATE INDEX `BreakOutWithAfter_endDate` ON `BreakOutWithAfter` (`endDate`);--> statement-breakpoint
CREATE INDEX `BreakOutWithAfter_startDate` ON `BreakOutWithAfter` (`startDate`);--> statement-breakpoint
CREATE INDEX `BreakOutWithAfter_symbol` ON `BreakOutWithAfter` (`symbol`);--> statement-breakpoint
CREATE INDEX `crossCheck_endDate` ON `CrossCheck` (`endDate`);--> statement-breakpoint
CREATE INDEX `crossCheck_RollWindowInHours` ON `CrossCheck` (`rollWindowInHours`);--> statement-breakpoint
CREATE INDEX `crossCheck_startDate` ON `CrossCheck` (`startDate`);--> statement-breakpoint
CREATE INDEX `crossCheck_symbol` ON `CrossCheck` (`symbol`);--> statement-breakpoint
CREATE INDEX `grokCandleTrend_symbol` ON `GrokCandleTrend` (`symbol`);--> statement-breakpoint
CREATE INDEX `grokCandleTrend_startDate` ON `GrokCandleTrend` (`startDate`);--> statement-breakpoint
CREATE INDEX `grokCandleTrend_endDate` ON `GrokCandleTrend` (`endDate`);--> statement-breakpoint
CREATE INDEX `grokCandleTrend_RollWindowInHours` ON `GrokCandleTrend` (`rollWindowInHours`);--> statement-breakpoint
CREATE INDEX `grokCopyWithMarketState_endDate` ON `GrokCopyWithMarketState` (`endDate`);--> statement-breakpoint
CREATE INDEX `grokCopyWithMarketState_RollWindowInHours` ON `GrokCopyWithMarketState` (`rollWindowInHours`);--> statement-breakpoint
CREATE INDEX `grokCopyWithMarketState_startDate` ON `GrokCopyWithMarketState` (`startDate`);--> statement-breakpoint
CREATE INDEX `grokCopyWithMarketState_symbol` ON `GrokCopyWithMarketState` (`symbol`);--> statement-breakpoint
CREATE INDEX `grokCopyWithoutMarketState_endDate` ON `GrokCopyWithoutMarketState` (`endDate`);--> statement-breakpoint
CREATE INDEX `grokCopyWithoutMarketState_RollWindowInHours` ON `GrokCopyWithoutMarketState` (`rollWindowInHours`);--> statement-breakpoint
CREATE INDEX `grokCopyWithoutMarketState_startDate` ON `GrokCopyWithoutMarketState` (`startDate`);--> statement-breakpoint
CREATE INDEX `grokCopyWithoutMarketState_symbol` ON `GrokCopyWithoutMarketState` (`symbol`);--> statement-breakpoint
CREATE INDEX `grokUpDownOnly_endDate` ON `GrokUpDownOnly` (`endDate`);--> statement-breakpoint
CREATE INDEX `grokUpDownOnly_RollWindowInHours` ON `GrokUpDownOnly` (`rollWindowInHours`);--> statement-breakpoint
CREATE INDEX `grokUpDownOnly_startDate` ON `GrokUpDownOnly` (`startDate`);--> statement-breakpoint
CREATE INDEX `grokUpDownOnly_symbol` ON `GrokUpDownOnly` (`symbol`);--> statement-breakpoint
CREATE INDEX `NewPriceTicker_symbol` ON `NewPriceTicker` (`symbol`);--> statement-breakpoint
CREATE INDEX `NewPriceTicker_timestamp` ON `NewPriceTicker` (`timestamp`);--> statement-breakpoint
CREATE INDEX `PriceTicker_symbol` ON `PriceTicker` (`symbol`);--> statement-breakpoint
CREATE INDEX `PriceTicker_timestamp` ON `PriceTicker` (`timestamp`);--> statement-breakpoint
CREATE INDEX `speculation_symbol` ON `Speculation` (`symbol`);--> statement-breakpoint
CREATE INDEX `speculation_startDate` ON `Speculation` (`startDate`);--> statement-breakpoint
CREATE INDEX `speculation_endDate` ON `Speculation` (`endDate`);--> statement-breakpoint
CREATE INDEX `speculation_RollWindowInHours` ON `Speculation` (`rollWindowInHours`);--> statement-breakpoint
CREATE INDEX `idx_runId` ON `bitbot_entries` (`runId`);--> statement-breakpoint
CREATE INDEX `idx_entryTime` ON `bitbot_entries` (`entryTime`);--> statement-breakpoint
CREATE INDEX `idx_resolveTime` ON `bitbot_entries` (`resolveTime`);--> statement-breakpoint
CREATE INDEX `idx_positionSide` ON `bitbot_entries` (`positionSide`);--> statement-breakpoint
CREATE INDEX `idx_tradeMode` ON `bitbot_entries` (`tradeMode`);--> statement-breakpoint
CREATE INDEX `idx_realizedProfit` ON `bitbot_entries` (`realizedProfit`);
*/


CREATE TABLE `BitBotCommit` (
	`id` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
	`runId` varchar(256) NOT NULL,
	`entryTime` datetime NOT NULL,
	`entryAvgPrice` double NOT NULL,
	`wsPriceAtEntry` double NOT NULL,
	`wsTimeAtEntry` datetime NOT NULL,
	`resolveTime` datetime NOT NULL,
	`resolveAvgPrice` double NOT NULL,
	`wsPriceAtResolve` double NOT NULL,
	`wsTimeAtResolve` datetime NOT NULL,
	`realizedProfit` double NOT NULL,
	`positionSide` varchar(50) NOT NULL,
	`tradeMode` varchar(50) NOT NULL,
	`leverage` INT NOT NULL,
	`margin` double NOT NULL,
	`posId` varchar(256) NOT NULL
);

CREATE INDEX `BitBotCommitIdx_entryTime` ON `BitBotCommit` (`entryTime`);
CREATE INDEX `BitBotCommitIdx_resolveTime` ON `BitBotCommit` (`resolveTime`);
CREATE INDEX `BitBotCommitIdx_tradeMode` ON `BitBotCommit` (`tradeMode`);
CREATE INDEX `BitBotCommitIdx_positionSide` ON `BitBotCommit` (`positionSide`);
