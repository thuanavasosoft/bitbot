/**
 * Binance API utilities for fetching candle data
 */

const BINANCE_REST_API = 'https://api.binance.com/api/v3';
const BINANCE_FUTURES_API = 'https://fapi.binance.com/fapi/v1';

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  isFinal?: boolean;
}

export interface SymbolInfo {
  symbol: string;
  status: string;
  contractType: string;
  quoteAsset: string;
  filters: Array<{
    filterType: string;
    tickSize?: string;
    [key: string]: any;
  }>;
  quoteAssetPrecision?: number;
  [key: string]: any;
}

export interface ExchangeInfo {
  symbols: SymbolInfo[];
  [key: string]: any;
}

/**
 * Fetch historical klines (candles) from Binance Futures REST API
 * @param symbol - Trading pair symbol (e.g., 'BTCUSDT')
 * @param interval - Time interval (e.g., '1m', '5m', '1h')
 * @param limit - Number of candles to fetch (max 1000)
 * @param startTime - Optional start time (timestamp in ms)
 * @param endTime - Optional end time (timestamp in ms)
 * @returns Array of candle data
 */
export async function fetchHistoricalKlines(
  symbol: string,
  interval: string,
  limit: number = 200,
  startTime: number | null = null,
  endTime: number | null = null
): Promise<Candle[]> {
  try {
    let url = `${BINANCE_FUTURES_API}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    
    if (startTime) {
      url += `&startTime=${startTime}`;
    }
    if (endTime) {
      url += `&endTime=${endTime}`;
    }
    
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch klines: ${response.statusText}`);
    }
    
    const data = await response.json();
    
    // Transform Binance API response to our candle format
    return data.map((kline: any[]): Candle => ({
      openTime: kline[0],
      open: parseFloat(kline[1]),
      high: parseFloat(kline[2]),
      low: parseFloat(kline[3]),
      close: parseFloat(kline[4]),
      volume: parseFloat(kline[5]),
      closeTime: kline[6],
    }));
  } catch (error) {
    console.error('Error fetching historical klines:', error);
    throw error;
  }
}

/**
 * Create WebSocket URL for Binance Futures kline stream
 * @param symbol - Trading pair symbol (lowercase, e.g., 'btcusdt')
 * @param interval - Time interval (e.g., '1m', '5m', '1h')
 * @returns WebSocket URL
 */
export function getBinanceWebSocketUrl(symbol: string, interval: string): string {
  const normalizedSymbol = symbol.toLowerCase();
  // Use Futures WebSocket endpoint
  return `wss://fstream.binance.com/ws/${normalizedSymbol}@kline_${interval}`;
}

/**
 * Fetch symbol information from Binance Futures exchangeInfo
 * @param symbol - Trading pair symbol (e.g., 'BTCUSDT')
 * @returns Symbol information object
 */
export async function fetchSymbolInfo(symbol: string): Promise<SymbolInfo> {
  try {
    const response = await fetch(
      `${BINANCE_FUTURES_API}/exchangeInfo?symbol=${symbol}`
    );
    
    if (!response.ok) {
      throw new Error(`Failed to fetch exchange info: ${response.statusText}`);
    }
    
    const data: ExchangeInfo = await response.json();
    const symbolInfo = data.symbols.find(s => s.symbol === symbol);
    
    if (!symbolInfo) {
      throw new Error(`Symbol ${symbol} not found`);
    }
    
    return symbolInfo;
  } catch (error) {
    console.error('Error fetching symbol info:', error);
    throw error;
  }
}

/**
 * Calculate price precision from tickSize
 * @param tickSize - Tick size (e.g., '0.0001' or 0.0001)
 * @returns Number of decimal places
 */
export function getPricePrecisionFromTickSize(tickSize: string | number): number {
  const tickSizeStr = tickSize.toString();
  if (tickSizeStr.includes('.')) {
    // Find the position of the first non-zero digit after the decimal point
    const decimalPart = tickSizeStr.split('.')[1];
    
    // Find the position of '1' (the significant digit in tickSize)
    const firstOneIndex = decimalPart.indexOf('1');
    if (firstOneIndex !== -1) {
      // Precision is the position of '1' + 1 (to include it)
      return firstOneIndex + 1;
    }
    
    // Fallback: count all decimal digits
    return decimalPart.length;
  }
  // If tickSize is 1 or greater, precision is 0
  return 0;
}

/**
 * Get price precision for a symbol
 * @param symbol - Trading pair symbol (e.g., 'BTCUSDT')
 * @returns Price precision (number of decimal places)
 */
export async function getSymbolPricePrecision(symbol: string): Promise<number> {
  try {
    const symbolInfo = await fetchSymbolInfo(symbol);
    const priceFilter = symbolInfo.filters.find(
      filter => filter.filterType === 'PRICE_FILTER'
    );
    
    if (!priceFilter || !priceFilter.tickSize) {
      // Fallback: use quoteAssetPrecision if available
      return symbolInfo.quoteAssetPrecision || 8;
    }
    
    return getPricePrecisionFromTickSize(priceFilter.tickSize);
  } catch (error) {
    console.error('Error getting price precision:', error);
    // Default to 8 decimals as fallback
    return 8;
  }
}

/**
 * Transform Binance WebSocket kline data to our candle format
 * @param wsData - WebSocket message data
 * @returns Candle object
 */
export function transformWebSocketKline(wsData: any): Candle {
  const kline = wsData.k;
  return {
    openTime: kline.t,
    open: parseFloat(kline.o),
    high: parseFloat(kline.h),
    low: parseFloat(kline.l),
    close: parseFloat(kline.c),
    volume: parseFloat(kline.v),
    closeTime: kline.T,
    isFinal: kline.x, // true if this candle closed, false if still updating
  };
}

/**
 * Fetch all available Futures symbols from Binance
 * @returns Array of symbol strings (e.g., ['BTCUSDT', 'ETHUSDT', ...])
 */
export async function fetchFuturesSymbols(): Promise<string[]> {
  try {
    const response = await fetch(`${BINANCE_FUTURES_API}/exchangeInfo`);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch Futures symbols: ${response.statusText}`);
    }
    
    const data: ExchangeInfo = await response.json();
    
    // Filter only active USDT perpetual contracts and extract symbols
    const symbols = data.symbols
      .filter(symbol => 
        symbol.status === 'TRADING' && 
        symbol.contractType === 'PERPETUAL' &&
        symbol.quoteAsset === 'USDT'
      )
      .map(symbol => symbol.symbol)
      .sort();
    
    return symbols;
  } catch (error) {
    console.error('Error fetching Futures symbols:', error);
    throw error;
  }
}

/**
 * Get milliseconds for an interval string
 * @param interval - Time interval (e.g., '1m', '5m', '1h', '1d')
 * @returns Milliseconds for the interval
 */
function getIntervalMilliseconds(interval: string): number {
  const intervalMap: { [key: string]: number } = {
    '1m': 60 * 1000,
    '3m': 3 * 60 * 1000,
    '5m': 5 * 60 * 1000,
    '15m': 15 * 60 * 1000,
    '30m': 30 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '2h': 2 * 60 * 60 * 1000,
    '4h': 4 * 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
    '8h': 8 * 60 * 60 * 1000,
    '12h': 12 * 60 * 60 * 1000,
    '1d': 24 * 60 * 60 * 1000,
    '3d': 3 * 24 * 60 * 60 * 1000,
    '1w': 7 * 24 * 60 * 60 * 1000,
    '1M': 30 * 24 * 60 * 60 * 1000,
  };
  
  return intervalMap[interval] || 60 * 1000; // Default to 1 minute
}

/**
 * Fetch all historical klines for a time range by chaining multiple requests
 * Binance API limit is 1000 candles per request, so we need to chain if range is larger
 * @param symbol - Trading pair symbol (e.g., 'BTCUSDT')
 * @param interval - Time interval (e.g., '1m', '5m', '1h')
 * @param startTime - Start time (timestamp in ms)
 * @param endTime - End time (timestamp in ms)
 * @param maxLimit - Maximum candles per request (default 1000)
 * @returns Array of all candle data in the range
 */
export async function fetchAllHistoricalKlines(
  symbol: string,
  interval: string,
  startTime: number,
  endTime: number,
  maxLimit: number = 1000
): Promise<Candle[]> {
  try {
    const allCandles: Candle[] = [];
    let currentStartTime = startTime;
    const intervalMs = getIntervalMilliseconds(interval);
    
    while (currentStartTime < endTime) {
      // Calculate how many candles we can fetch in this request
      const timeDiff = endTime - currentStartTime;
      const maxCandlesInRange = Math.ceil(timeDiff / intervalMs);
      const limit = Math.min(maxLimit, maxCandlesInRange);
      
      console.log(`Fetching candles from ${new Date(currentStartTime).toISOString()} (limit: ${limit})...`);
      
      // Fetch candles for this chunk
      const candles = await fetchHistoricalKlines(
        symbol,
        interval,
        limit,
        currentStartTime,
        endTime
      );
      
      if (candles.length === 0) {
        // No more candles available
        break;
      }
      
      allCandles.push(...candles);
      
      // Update currentStartTime to the next candle after the last one received
      const lastCandleCloseTime = candles[candles.length - 1].closeTime;
      currentStartTime = lastCandleCloseTime + 1;
      
      // If we got fewer candles than requested, we've reached the end
      if (candles.length < limit) {
        break;
      }
      
      // Add a small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    console.log(`Fetched ${allCandles.length} total candles`);
    return allCandles;
  } catch (error) {
    console.error('Error fetching all historical klines:', error);
    throw error;
  }
}

