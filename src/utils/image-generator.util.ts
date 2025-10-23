import fs from 'fs';
import type { ICandleInfo, TPositionSide } from '@/services/exchange-service/exchange-type';
import annotationPlugin from 'chartjs-plugin-annotation';

import { CategoryScale, Chart, Legend, LinearScale, LineController, LineElement, PointElement, Title, Tooltip } from 'chart.js';
import { createCanvas } from 'canvas';

Chart.register(
  CategoryScale,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Legend,
  Title,
  Tooltip,
  annotationPlugin,
);


export async function generateImageOfCandles(
  symbol: string,
  candles: ICandleInfo[],
  writeFile: boolean = false,
  endDate: Date,
  currOpenedPos?: { avgPrice: number, side: TPositionSide },
): Promise<Buffer> {
  const canvas = createCanvas(1000, 1000);
  const ctx = canvas.getContext('2d');

  const greenColor = "#008000";
  const redColor = "#800000";

  const avgPriceColor = currOpenedPos?.side === "long" ? greenColor : redColor;
  const annotation = !!currOpenedPos ? {
    annotations: {
      avgPrice: {
        type: 'line' as any,
        yMin: currOpenedPos?.avgPrice!,
        yMax: currOpenedPos?.avgPrice!,
        borderColor: avgPriceColor,
        borderWidth: 2,
        borderDash: [6, 6],
        label: {
          display: true,
          content: [currOpenedPos?.side.toUpperCase(), currOpenedPos?.avgPrice!],
          position: "start",
          backgroundColor: avgPriceColor,
          color: "#FFFFFF",
          xAdjust: -4,
          font: {
            size: 12,
            weight: "bold",
          },
          padding: 5,
          borderRadius: 4,
          textAlign: "left",
        },
      },
    }
  } : {};
  const datasets = [{
    label: 'Price',
    data: candles.map((candle) => candle.closePrice),
    fill: false,
    borderColor: 'rgb(75, 192, 192)',
    tension: 0.1
  }];
  if (!!currOpenedPos) datasets.push({
    label: 'Position Avg Price',
    data: [currOpenedPos?.avgPrice!],
    fill: false,
    borderColor: avgPriceColor,
    tension: 0.1
  });

  const chart = new Chart(
    ctx,
    {
      type: 'line',
      data: {
        labels: candles.map((candle) => candle.timestamp),
        datasets,
      },
      options: {
        plugins: { annotation }
      },
    },
  );

  const image = canvas.toBuffer('image/png');
  if (writeFile) {
    const filePath = `./${symbol}_chart_${endDate.toISOString().split('T')[0]}_1m.png`;
    fs.writeFileSync(filePath, image as any);
  }

  chart.destroy();
  return image;
}