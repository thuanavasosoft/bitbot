import { IPosition, TPositionSide } from "@/services/exchange-service/exchange-type";
import moment from "moment";
import { BigNumber } from "bignumber.js";

export function parseDurationStringIntoMs(input: string): number {
  const trimmed = input.trim();
  const hoursMatch = trimmed.match(/(\d+)h/);
  const minutesMatch = trimmed.match(/(\d+)m/);

  const hours = hoursMatch ? parseInt(hoursMatch[1], 10) : 0;
  const minutes = minutesMatch ? parseInt(minutesMatch[1], 10) : 0;

  return (hours * 3600 + minutes * 60) * 1000;
}

export function getRunDuration(startTime: Date): { runDurationInDays: number, runDurationDisplay: string } {
  const runDurationInMS = moment(new Date()).diff(startTime);
  const runDurationInSecond = runDurationInMS / 1000;
  const runDurationInMinutes = runDurationInSecond / 60;
  const runDurationInHours = runDurationInMinutes / 60;
  const runDurationInDays = runDurationInHours / 24;

  const momentDuration = moment.duration(runDurationInMS);

  const years = momentDuration.years();
  const months = momentDuration.months();
  const days = momentDuration.days();
  const hours = momentDuration.hours();
  const minutes = momentDuration.minutes();
  const seconds = momentDuration.seconds();

  const formattedDuration = `${years}Y${months}M${days}D ${hours}H${minutes}m${seconds}s`;

  return { runDurationInDays, runDurationDisplay: formattedDuration };
}

export function getMsDetailDuration(millis: number): { years: number, months: number, days: number, hours: number, minutes: number, seconds: number } {
  const totalSeconds = Math.floor(millis / 1000);
  // Ambil tahun, bulan, hari, jam, menit, detik dari total millis
  let remainingSeconds = totalSeconds;

  const years = Math.floor(remainingSeconds / (365 * 24 * 3600));
  remainingSeconds = remainingSeconds % (365 * 24 * 3600);

  const months = Math.floor(remainingSeconds / (30 * 24 * 3600));
  remainingSeconds = remainingSeconds % (30 * 24 * 3600);

  const days = Math.floor(remainingSeconds / (24 * 3600));
  remainingSeconds = remainingSeconds % (24 * 3600);

  const hours = Math.floor(remainingSeconds / 3600);
  remainingSeconds = remainingSeconds % 3600;

  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;

  return { years, months, days, hours, minutes, seconds }
}

export function calc_UnrealizedPnl(pos: IPosition, p: number): number {
  const markPrice = new BigNumber(p);
  const avgPrice = new BigNumber(pos.avgPrice);
  const size = new BigNumber(pos.size);

  let pnl: BigNumber;

  if (pos.side === "long") {
    pnl = markPrice.minus(avgPrice).times(size);
  } else {
    pnl = avgPrice.minus(markPrice).times(size);
  }

  return pnl.toNumber();
}

export function generateRandomNumberOfLength(length: number): number {
  if (length <= 0) throw new Error("Length must be positive integer");
  if (length === 1) return Math.floor(Math.random() * 10);

  const min = Math.pow(10, length - 1);
  const max = Math.pow(10, length) - 1;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Calculates the liquidation price for an isolated margin position.
 * Formula (for simple perpetual contracts, not including fees):
 * 
 * For LONG:
 *   liquidationPrice = (avgPrice * leverage) / (leverage + 1)
 * 
 * For SHORT:
 *   liquidationPrice = (avgPrice * leverage) / (leverage - 1)
 * 
 * Assumptions:
 * - pos is an object with `avgPrice` (number|string), `leverage` (number), and `side` ("long"|"short")
 * - Leverage must be > 1 for "short" to avoid division by zero.
 */
export function calcLiquidationPrice(
  side: TPositionSide,
  avgPrice: number | string,
  leverage: number
): number {
  const price = typeof avgPrice === "string" ? parseFloat(avgPrice) : avgPrice;
  if (leverage <= 1) {
    throw new Error("Leverage must be greater than 1 to calculate liquidation price");
  }
  if (side === "long") {
    return (price * leverage) / (leverage + 1);
  } else if (side === "short") {
    return (price * leverage) / (leverage - 1);
  } else {
    throw new Error("Unknown side given to calcLiquidationPrice: " + side);
  }
}
