import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import type { ChartTypeRegistry } from 'chart.js';
import fs from 'fs';
import type { ICandleInfo } from '@/services/exchange-service/exchange-type';


export async function generateImageOfCandles(
  symbol: string,
  candles: ICandleInfo[],
  writeFile: boolean = false,
  endDate: Date
): Promise<Buffer> {
  const chart = new ChartJSNodeCanvas({ width: 1000, height: 1000 });

  const chartConfig = {
    type: 'line' as keyof ChartTypeRegistry,
    data: {
      labels: candles.map((candle) => candle.timestamp),
      datasets: [{
        label: 'Price',
        data: candles.map((candle) => candle.closePrice),
        fill: false,
        borderColor: 'rgb(75, 192, 192)',
        tension: 0.1
      }]
    }
  };

  const image = await chart.renderToBuffer(chartConfig);

  if (writeFile) {
    const filePath = `./${symbol}_chart_${endDate.toISOString().split('T')[0]}_1m.png`;
    fs.writeFileSync(filePath, image as any);
  }

  return image;
}