import { mysqlTable, primaryKey, int, varchar, datetime, index, double } from "drizzle-orm/mysql-core"

export const PriceTickerSchema = mysqlTable('PriceTicker', {
  id: int("id").primaryKey().autoincrement().notNull(),
  symbol: varchar("symbol", { length: 256 }).notNull(),
  lastPrice: double("lastPrice").notNull(),
  timestamp: datetime("timestamp", { mode: "date" }).notNull(),
}, (PriceTicker) => ({
  idx_symbol: index("PriceTicker_symbol").on(PriceTicker.symbol),
  idx_timestamp: index("PriceTicker_timestamp").on(PriceTicker.timestamp),
}));

export const NewPriceTickerSchema = mysqlTable('NewPriceTicker', {
  id: int("id").primaryKey().autoincrement().notNull(),
  symbol: varchar("symbol", { length: 256 }).notNull(),
  lastPrice: double("lastPrice").notNull(),
  timestamp: datetime("timestamp", { mode: "date" }).notNull(),
}, (NewPriceTicker) => ({
  idx_symbol: index("NewPriceTicker_symbol").on(NewPriceTicker.symbol),
  idx_timestamp: index("NewPriceTicker_timestamp").on(NewPriceTicker.timestamp),
}));

export const OrderBookSchema = mysqlTable('OrderBookTicker', {
  id: int("id").primaryKey().autoincrement().notNull(),
  symbol: varchar("symbol", { length: 256 }).notNull(),
  askPrice: double("askPrice").notNull(),
  bidPrice: double("bidPrice").notNull(),
  timestamp: datetime("timestamp", { mode: "date" }).notNull(),
}, (BookTicker) => ({
  idx_symbol: index("PriceTicker_symbol").on(BookTicker.symbol),
  idx_timestamp: index("PriceTicker_timestamp").on(BookTicker.timestamp),
}));

export const aiBotTrend = mysqlTable("AiBotTrend", {
  id: int("id").autoincrement().notNull(),
  symbol: varchar("symbol", { length: 256 }).notNull(),
  trend: varchar("trend", { length: 10 }).notNull(),
  startDate: datetime("startDate", { mode: 'string' }).notNull(),
  endDate: datetime("endDate", { mode: 'string' }).notNull(),
  closePrice: varchar("closePrice", { length: 256 }).notNull(),
},
  (table) => {
    return {
      aiBotTrendId: primaryKey({ columns: [table.id], name: "AiBotTrend_id" }),
    }
  });

export const aiBotTrend12 = mysqlTable("AiBotTrend12", {
  id: int("id").autoincrement().notNull(),
  symbol: varchar("symbol", { length: 256 }).notNull(),
  trend: varchar("trend", { length: 10 }).notNull(),
  startDate: datetime("startDate", { mode: 'string' }).notNull(),
  endDate: datetime("endDate", { mode: 'string' }).notNull(),
  closePrice: varchar("closePrice", { length: 256 }).notNull(),
},
  (table) => {
    return {
      endDate: index("AiBotTrend12_endDate").on(table.endDate),
      startDate: index("AiBotTrend12_startDate").on(table.startDate),
      symbol: index("AiBotTrend12_symbol").on(table.symbol),
      aiBotTrend12Id: primaryKey({ columns: [table.id], name: "AiBotTrend12_id" }),
    }
  });

export const aiBotTrend24 = mysqlTable("AiBotTrend24", {
  id: int("id").autoincrement().notNull(),
  symbol: varchar("symbol", { length: 256 }).notNull(),
  trend: varchar("trend", { length: 10 }).notNull(),
  startDate: datetime("startDate", { mode: 'string' }).notNull(),
  endDate: datetime("endDate", { mode: 'string' }).notNull(),
  closePrice: varchar("closePrice", { length: 256 }).notNull(),
},
  (table) => {
    return {
      endDate: index("AiBotTrend24_endDate").on(table.endDate),
      startDate: index("AiBotTrend24_startDate").on(table.startDate),
      symbol: index("AiBotTrend24_symbol").on(table.symbol),
      aiBotTrend24Id: primaryKey({ columns: [table.id], name: "AiBotTrend24_id" }),
    }
  });

export const grokWithMarketState = mysqlTable("GrokCopyWithMarketState", {
  id: int("id").autoincrement().notNull(),
  symbol: varchar("symbol", { length: 256 }).notNull(),
  trend: varchar("trend", { length: 10 }).notNull(),
  startDate: datetime("startDate", { mode: 'string' }).notNull(),
  endDate: datetime("endDate", { mode: 'string' }).notNull(),
  closePrice: varchar("closePrice", { length: 256 }).notNull(),
  rollWindowInHours: int("rollWindowInHours").notNull(),
  marketState: varchar("marketState", { length: 256 }),
},
  (table) => {
    return {
      grokCandleTrendEndDate: index("grokCandleTrend_endDate").on(table.endDate),
      grokCandleTrendRollWindowInHours: index("grokCandleTrend_RollWindowInHours").on(table.rollWindowInHours),
      grokCandleTrendStartDate: index("grokCandleTrend_startDate").on(table.startDate),
      grokCandleTrendSymbol: index("grokCandleTrend_symbol").on(table.symbol),
      grokCandleTrendId: primaryKey({ columns: [table.id], name: "GrokCandleTrend_id" }),
    }
  });

export const grokWithoutMarketState = mysqlTable("GrokCopyWithoutMarketState", {
  id: int("id").autoincrement().notNull(),
  symbol: varchar("symbol", { length: 256 }).notNull(),
  trend: varchar("trend", { length: 10 }).notNull(),
  startDate: datetime("startDate", { mode: 'string' }).notNull(),
  endDate: datetime("endDate", { mode: 'string' }).notNull(),
  closePrice: varchar("closePrice", { length: 256 }).notNull(),
  rollWindowInHours: int("rollWindowInHours").notNull(),
  marketState: varchar("marketState", { length: 256 }),
},
  (table) => {
    return {
      grokCandleTrendEndDate: index("grokCandleTrend_endDate").on(table.endDate),
      grokCandleTrendRollWindowInHours: index("grokCandleTrend_RollWindowInHours").on(table.rollWindowInHours),
      grokCandleTrendStartDate: index("grokCandleTrend_startDate").on(table.startDate),
      grokCandleTrendSymbol: index("grokCandleTrend_symbol").on(table.symbol),
      grokCandleTrendId: primaryKey({ columns: [table.id], name: "GrokCandleTrend_id" }),
    }
  });

export const grokUpDownOnly = mysqlTable("GrokUpDownOnly", {
  id: int("id").autoincrement().notNull(),
  symbol: varchar("symbol", { length: 256 }).notNull(),
  trend: varchar("trend", { length: 10 }).notNull(),
  startDate: datetime("startDate", { mode: 'string' }).notNull(),
  endDate: datetime("endDate", { mode: 'string' }).notNull(),
  closePrice: varchar("closePrice", { length: 256 }).notNull(),
  rollWindowInHours: int("rollWindowInHours").notNull(),
},
  (table) => {
    return {
      grokUpDownOnlyEndDate: index("grokUpDownOnly_endDate").on(table.endDate),
      grokUpDownOnlyRollWindowInHours: index("grokUpDownOnly_RollWindowInHours").on(table.rollWindowInHours),
      grokUpDownOnlyStartDate: index("grokUpDownOnly_startDate").on(table.startDate),
      grokUpDownOnlySymbol: index("grokUpDownOnly_symbol").on(table.symbol),
      grokUpDownOnlyId: primaryKey({ columns: [table.id], name: "grokUpDownOnly_id" }),
    }
  });

export const grokCopyWithoutMarketState = mysqlTable("GrokCopyWithoutMarketState", {
  id: int("id").autoincrement().notNull(),
  symbol: varchar("symbol", { length: 256 }).notNull(),
  trend: varchar("trend", { length: 10 }).notNull(),
  startDate: datetime("startDate", { mode: 'string' }).notNull(),
  endDate: datetime("endDate", { mode: 'string' }).notNull(),
  closePrice: varchar("closePrice", { length: 256 }).notNull(),
  rollWindowInHours: int("rollWindowInHours").notNull(),
  marketState: varchar("marketState", { length: 256 }),
},
  (table) => {
    return {
      grokCopyWithoutMarketStateId: primaryKey({ columns: [table.id], name: "grokCopyWithoutMarketState_id" }),
      grokCopyWithoutMarketStateEndDate: index("grokCopyWithoutMarketState_endDate").on(table.endDate),
      grokCopyWithoutMarketStateRollWindowInHours: index("grokCopyWithoutMarketState_RollWindowInHours").on(table.rollWindowInHours),
      grokCopyWithoutMarketStateStartDate: index("grokCopyWithoutMarketState_startDate").on(table.startDate),
      grokCopyWithoutMarketStateSymbol: index("grokCopyWithoutMarketState_symbol").on(table.symbol),
    }
  });

export const grokCopyWithMarketState = mysqlTable("GrokCopyWithMarketState", {
  id: int("id").autoincrement().notNull(),
  symbol: varchar("symbol", { length: 256 }).notNull(),
  trend: varchar("trend", { length: 10 }).notNull(),
  startDate: datetime("startDate", { mode: 'string' }).notNull(),
  endDate: datetime("endDate", { mode: 'string' }).notNull(),
  closePrice: varchar("closePrice", { length: 256 }).notNull(),
  rollWindowInHours: int("rollWindowInHours").notNull(),
  marketState: varchar("marketState", { length: 256 }),
},
  (table) => {
    return {
      grokCopyWithMarketStateId: primaryKey({ columns: [table.id], name: "grokCopyWithMarketState_id" }),
      grokCopyWithMarketStateEndDate: index("grokCopyWithMarketState_endDate").on(table.endDate),
      grokCopyWithMarketStateRollWindowInHours: index("grokCopyWithMarketState_RollWindowInHours").on(table.rollWindowInHours),
      grokCopyWithMarketStateStartDate: index("grokCopyWithMarketState_startDate").on(table.startDate),
      grokCopyWithMarketStateSymbol: index("grokCopyWithMarketState_symbol").on(table.symbol),
    }
  });

export const newPriceTicker = mysqlTable("NewPriceTicker", {
  id: int("id").autoincrement().notNull(),
  symbol: varchar("symbol", { length: 256 }).notNull(),
  lastPrice: double("lastPrice").notNull(),
  timestamp: datetime("timestamp", { mode: 'string' }).notNull(),
},
  (table) => {
    return {
      symbol: index("NewPriceTicker_symbol").on(table.symbol),
      timestamp: index("NewPriceTicker_timestamp").on(table.timestamp),
      newPriceTickerId: primaryKey({ columns: [table.id], name: "NewPriceTicker_id" }),
    }
  });

export const orderBookTicker = mysqlTable("OrderBookTicker", {
  id: int("id").autoincrement().notNull(),
  symbol: varchar("symbol", { length: 256 }).notNull(),
  askPrice: double("askPrice").notNull(),
  bidPrice: double("bidPrice").notNull(),
  timestamp: datetime("timestamp", { mode: 'string' }).notNull(),
},
  (table) => {
    return {
      orderBookTickerId: primaryKey({ columns: [table.id], name: "OrderBookTicker_id" }),
    }
  });

export const speculation = mysqlTable("Speculation", {
  id: int("id").autoincrement().notNull(),
  symbol: varchar("symbol", { length: 256 }).notNull(),
  trend: varchar("trend", { length: 10 }).notNull(),
  startDate: datetime("startDate", { mode: 'string' }).notNull(),
  endDate: datetime("endDate", { mode: 'string' }).notNull(),
  closePrice: varchar("closePrice", { length: 256 }).notNull(),
  rollWindowInHours: int("rollWindowInHours").notNull(),
},
  (table) => {
    return {
      speculationEndDate: index("speculation_endDate").on(table.endDate),
      speculationRollWindowInHours: index("speculation_RollWindowInHours").on(table.rollWindowInHours),
      speculationStartDate: index("speculation_startDate").on(table.startDate),
      speculationSymbol: index("speculation_symbol").on(table.symbol),
      speculationId: primaryKey({ columns: [table.id], name: "Speculation_id" }),
    }
  });