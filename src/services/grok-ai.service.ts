import TelegramService from "./telegram.service";

export type TAiCandleTrendV2 = "Up" | "Down" | "Unsure";
export type TAiCandleTrendDirection = "Up" | "Down" | "Kangaroo";
export type TAICandleBreakoutTrendWithAfter = "Up" | "Down" | "Already-Up" | "Already-Down";

export interface IAITrend {
  startDate: Date,
  endDate: Date,
  closePrice: number,
  trend: TAiCandleTrendDirection | TAICandleBreakoutTrendWithAfter,
}

class GrokAiService {
  private apiKey: string;

  constructor() {
    this.apiKey = process.env.GROKAI_API_KEY!;
  }

  async analyzeTrend(image: Buffer): Promise<TAiCandleTrendDirection> {
    try {
      const base64Image = image.toString('base64');

      const data = {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${base64Image}`,
                },
              },
              {
                type: "text",
                text: `
Only reply "Up" or "Down" or "Kangaroo" to an image of a crypto coin, nothing more.
Only elaborate about that decision if asked.

The image is the movement of a crypto coin recently.

You are to treat each image input separately and retain no memory between each to avoid being subjective.

Your job is NOT to speculate about the future, you only say what the image (the current presence) shows you. "Up" or "Down" or "Kangaroo" only.
`,
              },
            ],
          },
        ],
        model: "grok-2-vision-1212",
        temperature: 0,
      };

      const response = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      });

      const respData = await response.json() as any as any;
      const trend = respData.choices[0].message.content.trim();

      return trend
    } catch (error) {
      const errMsg = (error as Error)?.message || String(error);
      console.error(`Error upon analyzing trend: ${errMsg}. Retrying in 5 seconds`);
      TelegramService.queueMsg(`Error upon analyzing trend due to GrokAI API hiccup: ${errMsg}. Retrying in 5 seconds`);
      await new Promise(r => setTimeout(r, 5000));
      return this.analyzeTrend(image);
    }
  }

  async analyzeBreakOutTrend(image: Buffer): Promise<TAiCandleTrendDirection> {
    try {
      const base64Image = image.toString('base64');

      const data = {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${base64Image}`,
                },
              },
              {
                type: "text",
                text: `
Only reply "Up" or "Down" or "Kangaroo" to an image of a crypto coin, nothing more.

If the price has broken clearly above resistance with momentum, answer 'Up'.
If the price has broken clearly below support with momentum, answer 'Down'.
Otherwise, answer 'Kangaroo'.

Your job is NOT to speculate about the future, you only say what the image (the current presence) shows you. "Up" or "Down" or "Kangaroo" only.`,
              },
            ],
          },
        ],
        model: "grok-2-vision-1212",
        temperature: 0,
      };

      const response = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      });

      const respData = await response.json() as any;
      const trend = respData.choices[0].message.content.trim();

      return trend
    } catch (error) {
      const errMsg = (error as Error)?.message || String(error);
      console.error(`Error upon analyzing trend: ${errMsg}. Retrying in 5 seconds`);
      TelegramService.queueMsg(`Error upon analyzing trend due to GrokAI API hiccup: ${errMsg}. Retrying in 5 seconds`);
      await new Promise(r => setTimeout(r, 5000));
      return this.analyzeTrend(image);
    }
  }

  async analyzeBreakoutTrendWithAfter(image: Buffer): Promise<"Up" | "Down" | "Already-Up" | "Already-Down"> {
    try {
      console.log("Analyzing breakout trend with after");
      const base64Image = image.toString('base64');

      const data = {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${base64Image}`,
                },
              },
              {
                type: "text",
                text: `
Only reply "Up" or "Down" or "Already-Up" or "Already-Down". Nothing more.

Rules:

1. Say "Up" when the end of the image (to the right) is pressing into the breakout zone for an upward move but has not yet broken out.
2. Say "Already-Up" when the end of the image has clearly broken out above resistance with momentum.
3. Say "Down" when the end of the image (to the right) is pressing into the breakout zone for a downward move but has not yet broken out.
4. Say "Already-Down" when the end of the image has clearly broken out below support with momentum.

If unsure, pick the option with the higher probability of being correct.`,
              },
            ],
          },
        ],
        model: "grok-2-vision-1212",
        temperature: 0,
      };

      console.log("Fetching grok data response...");
      const response = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      });


      const respData = await response.json() as any;
      const trend = respData.choices[0].message.content.trim();

      return trend
    } catch (error) {
      console.log("Error upon analyzing breakout trend with after retrying in 5 seconds", error);
      await new Promise(r => setTimeout(r, 5000));
      return this.analyzeBreakoutTrendWithAfter(image);
    }
  }
}

export default GrokAiService;