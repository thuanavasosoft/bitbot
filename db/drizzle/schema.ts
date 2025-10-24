import { mysqlTable, mysqlSchema, AnyMySqlColumn, index, primaryKey, bigint, varchar, datetime, double, int } from "drizzle-orm/mysql-core"
import { sql } from "drizzle-orm"

export const bitBotCommit = mysqlTable("BitBotCommit", {
	id: bigint({ mode: "number", unsigned: true }).autoincrement().notNull(),
	runId: varchar({ length: 256 }).notNull(),
	entryTime: datetime({ mode: 'string'}).notNull(),
	entryAvgPrice: double().notNull(),
	wsPriceAtEntry: double().notNull(),
	wsTimeAtEntry: datetime({ mode: 'string'}).notNull(),
	resolveTime: datetime({ mode: 'string'}).notNull(),
	resolveAvgPrice: double().notNull(),
	wsPriceAtResolve: double().notNull(),
	wsTimeAtResolve: datetime({ mode: 'string'}).notNull(),
	realizedProfit: double().notNull(),
	positionSide: varchar({ length: 50 }).notNull(),
	tradeMode: varchar({ length: 50 }).notNull(),
	leverage: int().notNull(),
	margin: double().notNull(),
	posId: varchar({ length: 256 }).notNull(),
},
(table) => [
	index("BitBotCommitIdx_entryTime").on(table.entryTime),
	index("BitBotCommitIdx_positionSide").on(table.positionSide),
	index("BitBotCommitIdx_resolveTime").on(table.resolveTime),
	index("BitBotCommitIdx_tradeMode").on(table.tradeMode),
	primaryKey({ columns: [table.id], name: "BitBotCommit_id"}),
]);

export const breakOutTrend = mysqlTable("BreakOutTrend", {
	id: int().autoincrement().notNull(),
	symbol: varchar({ length: 256 }).notNull(),
	trend: varchar({ length: 10 }).notNull(),
	startDate: datetime({ mode: 'string'}).notNull(),
	endDate: datetime({ mode: 'string'}).notNull(),
	closePrice: varchar({ length: 256 }).notNull(),
	rollWindowInHours: int().notNull(),
},
(table) => [
	index("breakOutTrend_endDate").on(table.endDate),
	index("breakOutTrend_RollWindowInHours").on(table.rollWindowInHours),
	index("breakOutTrend_startDate").on(table.startDate),
	index("breakOutTrend_symbol").on(table.symbol),
	primaryKey({ columns: [table.id], name: "BreakOutTrend_id"}),
]);

export const breakOutWithAfter = mysqlTable("BreakOutWithAfter", {
	id: int().autoincrement().notNull(),
	symbol: varchar({ length: 256 }).notNull(),
	trend: varchar("Trend", { length: 100 }),
	startDate: datetime({ mode: 'string'}).notNull(),
	endDate: datetime({ mode: 'string'}).notNull(),
	closePrice: varchar({ length: 256 }).notNull(),
	rollWindowInHours: int().notNull(),
},
(table) => [
	index("BreakOutWithAfter_endDate").on(table.endDate),
	index("BreakOutWithAfter_startDate").on(table.startDate),
	index("BreakOutWithAfter_symbol").on(table.symbol),
	primaryKey({ columns: [table.id], name: "BreakOutWithAfter_id"}),
]);

export const crossCheck = mysqlTable("CrossCheck", {
	id: int().autoincrement().notNull(),
	symbol: varchar({ length: 256 }).notNull(),
	trend: varchar({ length: 256 }).notNull(),
	startDate: datetime({ mode: 'string'}).notNull(),
	endDate: datetime({ mode: 'string'}).notNull(),
	closePrice: varchar({ length: 256 }).notNull(),
	rollWindowInHours: int().notNull(),
	marketState: varchar({ length: 256 }),
},
(table) => [
	index("crossCheck_endDate").on(table.endDate),
	index("crossCheck_RollWindowInHours").on(table.rollWindowInHours),
	index("crossCheck_startDate").on(table.startDate),
	index("crossCheck_symbol").on(table.symbol),
	primaryKey({ columns: [table.id], name: "CrossCheck_id"}),
]);

export const grokCandleTrend = mysqlTable("GrokCandleTrend", {
	id: int().autoincrement().notNull(),
	symbol: varchar({ length: 256 }).notNull(),
	trend: varchar({ length: 10 }).notNull(),
	startDate: datetime({ mode: 'string'}).notNull(),
	endDate: datetime({ mode: 'string'}).notNull(),
	closePrice: varchar({ length: 256 }).notNull(),
	rollWindowInHours: int().notNull(),
	marketState: varchar({ length: 256 }),
},
(table) => [
	index("grokCandleTrend_endDate").on(table.endDate),
	index("grokCandleTrend_RollWindowInHours").on(table.rollWindowInHours),
	index("grokCandleTrend_startDate").on(table.startDate),
	index("grokCandleTrend_symbol").on(table.symbol),
	primaryKey({ columns: [table.id], name: "GrokCandleTrend_id"}),
]);

export const grokCopyWithMarketState = mysqlTable("GrokCopyWithMarketState", {
	id: int().autoincrement().notNull(),
	symbol: varchar({ length: 256 }).notNull(),
	trend: varchar({ length: 10 }).notNull(),
	startDate: datetime({ mode: 'string'}).notNull(),
	endDate: datetime({ mode: 'string'}).notNull(),
	closePrice: varchar({ length: 256 }).notNull(),
	rollWindowInHours: int().notNull(),
	marketState: varchar({ length: 256 }),
},
(table) => [
	index("grokCopyWithMarketState_endDate").on(table.endDate),
	index("grokCopyWithMarketState_RollWindowInHours").on(table.rollWindowInHours),
	index("grokCopyWithMarketState_startDate").on(table.startDate),
	index("grokCopyWithMarketState_symbol").on(table.symbol),
	primaryKey({ columns: [table.id], name: "GrokCopyWithMarketState_id"}),
]);

export const grokCopyWithoutMarketState = mysqlTable("GrokCopyWithoutMarketState", {
	id: int().autoincrement().notNull(),
	symbol: varchar({ length: 256 }).notNull(),
	trend: varchar({ length: 10 }).notNull(),
	startDate: datetime({ mode: 'string'}).notNull(),
	endDate: datetime({ mode: 'string'}).notNull(),
	closePrice: varchar({ length: 256 }).notNull(),
	rollWindowInHours: int().notNull(),
	marketState: varchar({ length: 256 }),
},
(table) => [
	index("grokCopyWithoutMarketState_endDate").on(table.endDate),
	index("grokCopyWithoutMarketState_RollWindowInHours").on(table.rollWindowInHours),
	index("grokCopyWithoutMarketState_startDate").on(table.startDate),
	index("grokCopyWithoutMarketState_symbol").on(table.symbol),
	primaryKey({ columns: [table.id], name: "GrokCopyWithoutMarketState_id"}),
]);

export const grokUpDownOnly = mysqlTable("GrokUpDownOnly", {
	id: int().autoincrement().notNull(),
	symbol: varchar({ length: 256 }).notNull(),
	trend: varchar({ length: 10 }).notNull(),
	startDate: datetime({ mode: 'string'}).notNull(),
	endDate: datetime({ mode: 'string'}).notNull(),
	closePrice: varchar({ length: 256 }).notNull(),
	rollWindowInHours: int().notNull(),
},
(table) => [
	index("grokUpDownOnly_endDate").on(table.endDate),
	index("grokUpDownOnly_RollWindowInHours").on(table.rollWindowInHours),
	index("grokUpDownOnly_startDate").on(table.startDate),
	index("grokUpDownOnly_symbol").on(table.symbol),
	primaryKey({ columns: [table.id], name: "GrokUpDownOnly_id"}),
]);

export const newPriceTicker = mysqlTable("NewPriceTicker", {
	id: int().autoincrement().notNull(),
	symbol: varchar({ length: 256 }).notNull(),
	lastPrice: double().notNull(),
	timestamp: datetime({ mode: 'string'}).notNull(),
},
(table) => [
	index("NewPriceTicker_symbol").on(table.symbol),
	index("NewPriceTicker_timestamp").on(table.timestamp),
	primaryKey({ columns: [table.id], name: "NewPriceTicker_id"}),
]);

export const orderBookTicker = mysqlTable("OrderBookTicker", {
	id: int().autoincrement().notNull(),
	symbol: varchar({ length: 256 }).notNull(),
	askPrice: double().notNull(),
	bidPrice: double().notNull(),
	timestamp: datetime({ mode: 'string'}).notNull(),
},
(table) => [
	primaryKey({ columns: [table.id], name: "OrderBookTicker_id"}),
]);

export const priceTicker = mysqlTable("PriceTicker", {
	id: int().autoincrement().notNull(),
	symbol: varchar({ length: 256 }).notNull(),
	lastPrice: double().notNull(),
	timestamp: datetime({ mode: 'string'}).notNull(),
},
(table) => [
	index("PriceTicker_symbol").on(table.symbol),
	index("PriceTicker_timestamp").on(table.timestamp),
	primaryKey({ columns: [table.id], name: "PriceTicker_id"}),
]);
