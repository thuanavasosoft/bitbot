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
  longTrigger?: number | null,
  shortTrigger?: number | null,
  fractionalStopRaw?: number | null,
  fractionalStopBuffered?: number | null,
): Promise<Buffer> {
  const canvas = createCanvas(1000, 1000);
  const ctx = canvas.getContext('2d');

  const greenColor = "#008000";
  const redColor = "#800000";
  const supportColor = "#FF0000"; // Red for support
  const resistanceColor = "#006400"; // Dark green for resistance (darker than bright green)

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

  // Add long trigger line if available
  if (longTrigger !== null && longTrigger !== undefined) {
    annotations.longTrigger = {
      type: 'line' as any,
      yMin: longTrigger,
      yMax: longTrigger,
      borderColor: "#32CD32", // Lime green for long trigger
      borderWidth: 2,
      borderDash: [3, 3],
      label: {
        display: true,
        content: [`Long Trigger: ${longTrigger.toFixed(4)}`],
        position: "end",
        backgroundColor: "#32CD32",
        color: "#FFFFFF",
        xAdjust: 4,
        font: {
          size: 11,
          weight: "bold",
        },
        padding: 4,
        borderRadius: 4,
        textAlign: "left",
      },
    };
  }

  // Add short trigger line if available
  if (shortTrigger !== null && shortTrigger !== undefined) {
    annotations.shortTrigger = {
      type: 'line' as any,
      yMin: shortTrigger,
      yMax: shortTrigger,
      borderColor: "#FF6347", // Tomato red for short trigger
      borderWidth: 2,
      borderDash: [3, 3],
      label: {
        display: true,
        content: [`Short Trigger: ${shortTrigger.toFixed(4)}`],
        position: "start",
        backgroundColor: "#FF6347",
        color: "#FFFFFF",
        xAdjust: -4,
        font: {
          size: 11,
          weight: "bold",
        },
        padding: 4,
        borderRadius: 4,
        textAlign: "left",
      },
    };
  }

  if (fractionalStopRaw !== null && fractionalStopRaw !== undefined) {
    annotations.fractionalStopRaw = {
      type: 'line' as any,
      yMin: fractionalStopRaw,
      yMax: fractionalStopRaw,
      borderColor: "#8A2BE2", // Blue Violet
      borderWidth: 2,
      borderDash: [4, 2],
      label: {
        display: true,
        content: [`Frac Stop: ${fractionalStopRaw.toFixed(4)}`],
        position: "start",
        backgroundColor: "#8A2BE2",
        color: "#FFFFFF",
        xAdjust: -4,
        font: {
          size: 11,
          weight: "bold",
        },
        padding: 4,
        borderRadius: 4,
        textAlign: "left",
      },
    };
  }

  if (fractionalStopBuffered !== null && fractionalStopBuffered !== undefined) {
    annotations.fractionalStopBuffered = {
      type: 'line' as any,
      yMin: fractionalStopBuffered,
      yMax: fractionalStopBuffered,
      borderColor: "#DA70D6", // Orchid
      borderWidth: 2,
      borderDash: [2, 2],
      label: {
        display: true,
        content: [`Resolve Trigger: ${fractionalStopBuffered.toFixed(4)}`],
        position: "end",
        backgroundColor: "#DA70D6",
        color: "#FFFFFF",
        xAdjust: 4,
        font: {
          size: 11,
          weight: "bold",
        },
        padding: 4,
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

export async function generatePnLProgressionChart(
  pnlHistory: Array<{ timestamp: number; totalPnL: number }>,
): Promise<Buffer> {
  const canvas = createCanvas(1000, 1000);
  const ctx = canvas.getContext('2d');

  const greenColor = "#008000";
  const redColor = "#800000";

  // Format timestamps to ISO format for x-axis labels
  const labels = pnlHistory.map((entry) => {
    const date = new Date(entry.timestamp);
    return date.toISOString();
  });

  // Determine line color based on latest PnL value
  const latestPnL = pnlHistory.length > 0 ? pnlHistory[pnlHistory.length - 1].totalPnL : 0;
  const lineColor = latestPnL >= 0 ? greenColor : redColor;

  const datasets = [{
    label: 'Total PnL (USDT)',
    data: pnlHistory.map((entry) => entry.totalPnL),
    fill: false,
    borderColor: lineColor,
    backgroundColor: lineColor,
    tension: 0.1,
    pointRadius: 3,
    pointHoverRadius: 5,
  }];

  const chart = new Chart(
    ctx,
    {
      type: 'line',
      data: {
        labels,
        datasets,
      },
      options: {
        responsive: true,
        plugins: {
          title: {
            display: true,
            text: 'PnL Progression',
            font: {
              size: 16,
              weight: 'bold',
            },
          },
          legend: {
            display: true,
            position: 'top',
          },
          tooltip: {
            callbacks: {
              label: function(context) {
                return `PnL: ${context.parsed?.y?.toFixed(4) ?? 0.0000} USDT`;
              },
            },
          },
        },
        scales: {
          x: {
            title: {
              display: true,
              text: 'Time (ISO Format)',
            },
            ticks: {
              maxRotation: 45,
              minRotation: 45,
              callback: function(value, index) {
                // Show every nth label to avoid overcrowding
                const step = Math.max(1, Math.floor(labels.length / 10));
                if (index % step === 0 || index === labels.length - 1) {
                  return labels[index];
                }
                return '';
              },
            },
          },
          y: {
            title: {
              display: true,
              text: 'Total PnL (USDT)',
            },
            ticks: {
              callback: function(value) {
                return Number(value).toFixed(2);
              },
            },
          },
        },
      },
    },
  );

  const image = canvas.toBuffer('image/png');
  chart.destroy();
  return image;
}