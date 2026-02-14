import {
	pgTable,
	index,
	primaryKey,
	bigserial,
	varchar,
	timestamp,
	doublePrecision,
	serial,
	integer,
	jsonb,
} from "drizzle-orm/pg-core";

export const bitBotCommit = pgTable(
	"BitBotCommit",
	{
		id: bigserial({ mode: "number" }).notNull(),
		runId: varchar({ length: 256 }).notNull(),
		entryTime: timestamp({ mode: "string" }).notNull(),
		entryAvgPrice: doublePrecision().notNull(),
		wsPriceAtEntry: doublePrecision().notNull(),
		wsTimeAtEntry: timestamp({ mode: "string" }).notNull(),
		resolveTime: timestamp({ mode: "string" }).notNull(),
		resolveAvgPrice: doublePrecision().notNull(),
		wsPriceAtResolve: doublePrecision().notNull(),
		wsTimeAtResolve: timestamp({ mode: "string" }).notNull(),
		realizedProfit: doublePrecision().notNull(),
		positionSide: varchar({ length: 50 }).notNull(),
		tradeMode: varchar({ length: 50 }).notNull(),
		leverage: integer().notNull(),
		margin: doublePrecision().notNull(),
		posId: varchar({ length: 256 }).notNull(),
		liquidationPrice: doublePrecision().notNull(),
	},
	(table) => [
		index("BitBotCommitIdx_entryTime").on(table.entryTime),
		index("BitBotCommitIdx_positionSide").on(table.positionSide),
		index("BitBotCommitIdx_resolveTime").on(table.resolveTime),
		index("BitBotCommitIdx_tradeMode").on(table.tradeMode),
		primaryKey({ columns: [table.id], name: "BitBotCommit_id" }),
	]
);

export const breakOutTrend = pgTable(
	"BreakOutTrend",
	{
		id: serial().primaryKey().notNull(),
		symbol: varchar({ length: 256 }).notNull(),
		trend: varchar({ length: 10 }).notNull(),
		startDate: timestamp({ mode: "string" }).notNull(),
		endDate: timestamp({ mode: "string" }).notNull(),
		closePrice: varchar({ length: 256 }).notNull(),
		rollWindowInHours: integer().notNull(),
	},
	(table) => [
		index("breakOutTrend_endDate").on(table.endDate),
		index("breakOutTrend_RollWindowInHours").on(table.rollWindowInHours),
		index("breakOutTrend_startDate").on(table.startDate),
		index("breakOutTrend_symbol").on(table.symbol),
	]
);

export const breakOutWithAfter = pgTable(
	"BreakOutWithAfter",
	{
		id: serial().primaryKey().notNull(),
		symbol: varchar({ length: 256 }).notNull(),
		trend: varchar("Trend", { length: 100 }),
		startDate: timestamp({ mode: "string" }).notNull(),
		endDate: timestamp({ mode: "string" }).notNull(),
		closePrice: varchar({ length: 256 }).notNull(),
		rollWindowInHours: integer().notNull(),
	},
	(table) => [
		index("BreakOutWithAfter_endDate").on(table.endDate),
		index("BreakOutWithAfter_startDate").on(table.startDate),
		index("BreakOutWithAfter_symbol").on(table.symbol),
	]
);

export const crossCheck = pgTable(
	"CrossCheck",
	{
		id: serial().primaryKey().notNull(),
		symbol: varchar({ length: 256 }).notNull(),
		trend: varchar({ length: 256 }).notNull(),
		startDate: timestamp({ mode: "string" }).notNull(),
		endDate: timestamp({ mode: "string" }).notNull(),
		closePrice: varchar({ length: 256 }).notNull(),
		rollWindowInHours: integer().notNull(),
		marketState: varchar({ length: 256 }),
	},
	(table) => [
		index("crossCheck_endDate").on(table.endDate),
		index("crossCheck_RollWindowInHours").on(table.rollWindowInHours),
		index("crossCheck_startDate").on(table.startDate),
		index("crossCheck_symbol").on(table.symbol),
	]
);

export const grokCandleTrend = pgTable(
	"GrokCandleTrend",
	{
		id: serial().primaryKey().notNull(),
		symbol: varchar({ length: 256 }).notNull(),
		trend: varchar({ length: 10 }).notNull(),
		startDate: timestamp({ mode: "string" }).notNull(),
		endDate: timestamp({ mode: "string" }).notNull(),
		closePrice: varchar({ length: 256 }).notNull(),
		rollWindowInHours: integer().notNull(),
		marketState: varchar({ length: 256 }),
	},
	(table) => [
		index("grokCandleTrend_endDate").on(table.endDate),
		index("grokCandleTrend_RollWindowInHours").on(table.rollWindowInHours),
		index("grokCandleTrend_startDate").on(table.startDate),
		index("grokCandleTrend_symbol").on(table.symbol),
	]
);

export const grokCopyWithMarketState = pgTable(
	"GrokCopyWithMarketState",
	{
		id: serial().primaryKey().notNull(),
		symbol: varchar({ length: 256 }).notNull(),
		trend: varchar({ length: 10 }).notNull(),
		startDate: timestamp({ mode: "string" }).notNull(),
		endDate: timestamp({ mode: "string" }).notNull(),
		closePrice: varchar({ length: 256 }).notNull(),
		rollWindowInHours: integer().notNull(),
		marketState: varchar({ length: 256 }),
	},
	(table) => [
		index("grokCopyWithMarketState_endDate").on(table.endDate),
		index("grokCopyWithMarketState_RollWindowInHours").on(table.rollWindowInHours),
		index("grokCopyWithMarketState_startDate").on(table.startDate),
		index("grokCopyWithMarketState_symbol").on(table.symbol),
	]
);

export const grokCopyWithoutMarketState = pgTable(
	"GrokCopyWithoutMarketState",
	{
		id: serial().primaryKey().notNull(),
		symbol: varchar({ length: 256 }).notNull(),
		trend: varchar({ length: 10 }).notNull(),
		startDate: timestamp({ mode: "string" }).notNull(),
		endDate: timestamp({ mode: "string" }).notNull(),
		closePrice: varchar({ length: 256 }).notNull(),
		rollWindowInHours: integer().notNull(),
		marketState: varchar({ length: 256 }),
	},
	(table) => [
		index("grokCopyWithoutMarketState_endDate").on(table.endDate),
		index("grokCopyWithoutMarketState_RollWindowInHours").on(table.rollWindowInHours),
		index("grokCopyWithoutMarketState_startDate").on(table.startDate),
		index("grokCopyWithoutMarketState_symbol").on(table.symbol),
	]
);

export const grokUpDownOnly = pgTable(
	"GrokUpDownOnly",
	{
		id: serial().primaryKey().notNull(),
		symbol: varchar({ length: 256 }).notNull(),
		trend: varchar({ length: 10 }).notNull(),
		startDate: timestamp({ mode: "string" }).notNull(),
		endDate: timestamp({ mode: "string" }).notNull(),
		closePrice: varchar({ length: 256 }).notNull(),
		rollWindowInHours: integer().notNull(),
	},
	(table) => [
		index("grokUpDownOnly_endDate").on(table.endDate),
		index("grokUpDownOnly_RollWindowInHours").on(table.rollWindowInHours),
		index("grokUpDownOnly_startDate").on(table.startDate),
		index("grokUpDownOnly_symbol").on(table.symbol),
	]
);

export const newPriceTicker = pgTable(
	"NewPriceTicker",
	{
		id: serial().primaryKey().notNull(),
		symbol: varchar({ length: 256 }).notNull(),
		lastPrice: doublePrecision().notNull(),
		timestamp: timestamp({ mode: "string" }).notNull(),
	},
	(table) => [
		index("NewPriceTicker_symbol").on(table.symbol),
		index("NewPriceTicker_timestamp").on(table.timestamp),
	]
);

export const orderBookTicker = pgTable("OrderBookTicker", {
	id: serial().primaryKey().notNull(),
	symbol: varchar({ length: 256 }).notNull(),
	askPrice: doublePrecision().notNull(),
	bidPrice: doublePrecision().notNull(),
	timestamp: timestamp({ mode: "string" }).notNull(),
});

export const priceTicker = pgTable(
	"PriceTicker",
	{
		id: serial().primaryKey().notNull(),
		symbol: varchar({ length: 256 }).notNull(),
		lastPrice: doublePrecision().notNull(),
		timestamp: timestamp({ mode: "string" }).notNull(),
	},
	(table) => [
		index("PriceTicker_symbol").on(table.symbol),
		index("PriceTicker_timestamp").on(table.timestamp),
	]
);

export const trailMultiplierOptimizationBotAction = pgTable(
	"TrailMultiplierOptimizationBotAction",
	{
		id: serial().primaryKey().notNull(),
		runId: varchar({ length: 256 }).notNull(),
		actionType: varchar({ length: 256 }).notNull(),
		meta: jsonb().notNull(),
		timestamp: timestamp({ mode: "string" }).notNull(),
	},
	(table) => [index("TrailMultiplierOptimizationBot_timestamp").on(table.timestamp)]
);
