import type { IPosition } from '@/services/exchange-service/exchange-type'

export function generateRandomString(length: number): string {
  return Math.random()
    .toString(36)
    .substring(2, length + 2)
}

// Explanation: We might need to split it according to this format
export function isSameOrderLinkId(input: string, stringPattern: string): boolean {
  const regex = new RegExp(`^${stringPattern}(?:-\\d+)?$`);
  return regex.test(input);
}

export function getPositionDetailMsg(position: IPosition) {
  return `
ID: ${position.id}
Side: ${position.side}
Leverage: X${position.leverage}
Size: ${position.size}
Notional Value: ${position.notional}

Liquidation Price: ${position.liquidationPrice}
Avg Price: ${position.avgPrice}

Realized PnL: ${position.realizedPnl}
Unrealized PnL: ${position.unrealizedPnl > 0 ? "🟩" : "🟥"} ${position.unrealizedPnl}`
}

export function getPlacedOrdersMsg(orderIds: string[], orderLinkIds: string[]) {
  return `
${orderIds.length === 1 ? `Order Id: ${orderIds[0]}` : `Order Ids: [${orderIds}]`}
${orderLinkIds.length === 1 ? `Order Link Id: ${orderLinkIds[0]}` : `Order Link Ids: [${orderLinkIds}]`}`
}

export function generateRunID() {
  // Generates a runId with the format "adjective_animal_YYYY-MM-DD_xxxx"
  const adjectives = [
    "brave", "quick", "clever", "happy", "sneaky", "nimble", "wise", "gentle", "feisty", "bold",
    "mighty", "silent", "curious", "jolly", "daring", "rich"
  ];
  const animals = [
    "cat", "dog", "bear", "fox", "owl", "koala", "lion", "tiger", "rabbit", "wolf",
    "eagle", "panda", "snake", "owl", "otter", "frog", "whale", "dolphin", "mouse", "moose"
  ];
  function pickRandom(arr: string[]) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  const adjective = pickRandom(adjectives);
  const animal = pickRandom(animals);
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = (today.getMonth() + 1).toString().padStart(2, "0");
  const dd = today.getDate().toString().padStart(2, "0");
  const dateStr = `${yyyy}-${mm}-${dd}`;
  // Random 4-digit alphanumeric
  const randomPart = Math.random().toString(36).substr(2, 4);

  return `${adjective}_${animal}_${dateStr}_${randomPart}`;
}