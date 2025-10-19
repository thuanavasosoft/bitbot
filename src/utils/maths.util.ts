import { IPosition } from "@/services/exchange-service/exchange-type";
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
