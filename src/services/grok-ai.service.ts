import TelegramService from "./telegram.service";

export type TAiCandleTrendV2 = "Up" | "Down" | "Unsure";
export type TAiCandleTrendDirection = "Up" | "Down" | "Kangaroo";

export interface IAITrend {
  startDate: Date,
  endDate: Date,
  closePrice: number,
  trend: TAiCandleTrendDirection,
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

  async analyzeShouldHoldOrResolve(image: Buffer): Promise<"Hold" | "Resolve"> {
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
System prompt (role: close decision maker):
Only reply "Hold" or "Resolve" to an image of a crypto chart.

If you are holding a LONG position:
Reply "Hold" if the price still shows higher highs or strong bullish structure.
Reply "Resolve" if price loses momentum, makes a lower high, or forms a rejection candle or reversal pattern.
If you are holding a SHORT position:
Reply "Hold" if the price still shows lower lows or bearish continuation.
Reply "Resolve" if price makes a higher low, loses bearish momentum, or shows rejection / consolidation.
Do not predict future movements — just read the current visual context.
You must only answer "Hold" or "Resolve", nothing else.
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


      const respData = await response.json() as any;
      const trend = respData.choices[0].message.content.trim();

      return trend
    } catch (error) {
      console.log("Error upon analyzing should hold or resolve after retrying in 5 seconds", error);
      await new Promise(r => setTimeout(r, 5000));
      return this.analyzeShouldHoldOrResolve(image);
    }
  }

  async analyzeBreakoutTrendV2(image: Buffer): Promise<"Up" | "Down" | "Kangaroo"> {
    try {
      console.log("Analyzing breakout trend v2");
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

Rules:
1. Say "Up" if the price has broken clearly above resistance and is holding above it with strong momentum or multiple candles confirming the breakout. The move should look sustained, not just a single spike.
2. Say "Down" if the price has broken clearly below support and is holding below it with strong momentum or multiple candles confirming the breakdown. The move should look sustained, not just a quick dip.
3. Say "Kangaroo" if the price looks uncertain, ranging, retesting, or if the breakout looks weak, fake, or immediately reversing.

Your job is NOT to speculate about the future. You only describe the current state shown in the image. 
If unsure, choose "Kangaroo".`,
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
      const errMsg = (error as Error)?.message || String(error);
      console.error(`Error upon analyzing trend: ${errMsg}. Retrying in 5 seconds`);
      TelegramService.queueMsg(`Error upon analyzing trend due to GrokAI API hiccup: ${errMsg}. Retrying in 5 seconds`);
      await new Promise(r => setTimeout(r, 5000));
      return this.analyzeBreakoutTrendV2(image);
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