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
  endDate?: Date,
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
    const filePath = `./${symbol}_chart_${endDate?.toISOString().split('T')[0]}_1m.png`;
    fs.writeFileSync(filePath, image as any);
  }

  chart.destroy();
  return image;
}

export async function generateImageOfCandlesWithSupportResistance(
  symbol: string,
  candles: ICandleInfo[],
  support: number | null,
  resistance: number | null,
  writeFile: boolean = false,
  endDate?: Date,
  currOpenedPos?: { avgPrice: number, side: TPositionSide },
): Promise<Buffer> {
  const canvas = createCanvas(1000, 1000);
  const ctx = canvas.getContext('2d');

  const greenColor = "#008000";
  const redColor = "#800000";
  const supportColor = "#FF0000"; // Red for support
  const resistanceColor = "#00FF00"; // Green for resistance

  const annotations: any = {};

  // Add support line if available
  if (support !== null) {
    annotations.support = {
      type: 'line' as any,
      yMin: support,
      yMax: support,
      borderColor: supportColor,
      borderWidth: 2,
      borderDash: [5, 5],
      label: {
        display: true,
        content: [`Support: ${support.toFixed(4)}`],
        position: "start",
        backgroundColor: supportColor,
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
    };
  }

  // Add resistance line if available
  if (resistance !== null) {
    annotations.resistance = {
      type: 'line' as any,
      yMin: resistance,
      yMax: resistance,
      borderColor: resistanceColor,
      borderWidth: 2,
      borderDash: [5, 5],
      label: {
        display: true,
        content: [`Resistance: ${resistance.toFixed(4)}`],
        position: "end",
        backgroundColor: resistanceColor,
        color: "#FFFFFF",
        xAdjust: 4,
        font: {
          size: 12,
          weight: "bold",
        },
        padding: 5,
        borderRadius: 4,
        textAlign: "left",
      },
    };
  }

  // Add position line if active
  if (!!currOpenedPos) {
    const avgPriceColor = currOpenedPos.side === "long" ? greenColor : redColor;
    annotations.avgPrice = {
      type: 'line' as any,
      yMin: currOpenedPos.avgPrice,
      yMax: currOpenedPos.avgPrice,
      borderColor: avgPriceColor,
      borderWidth: 2,
      borderDash: [6, 6],
      label: {
        display: true,
        content: [currOpenedPos.side.toUpperCase(), currOpenedPos.avgPrice.toFixed(4)],
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
    };
  }

  const datasets = [{
    label: 'Price',
    data: candles.map((candle) => candle.closePrice),
    fill: false,
    borderColor: 'rgb(75, 192, 192)',
    tension: 0.1
  }];

  const chart = new Chart(
    ctx,
    {
      type: 'line',
      data: {
        labels: candles.map((candle) => candle.timestamp),
        datasets,
      },
      options: {
        plugins: { 
          annotation: {
            annotations
          }
        }
      },
    },
  );

  const image = canvas.toBuffer('image/png');
  if (writeFile) {
    const filePath = `./${symbol}_chart_${endDate?.toISOString().split('T')[0]}_1m.png`;
    fs.writeFileSync(filePath, image as any);
  }

  chart.destroy();
  return image;
}