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
ID: ${position.positionId}
Side: ${position.side}
Leverage: X${position.leverage}
Size: ${position.size}
Notional Value: ${position.notional}

Liquidation Price: ${position.liquidationPrice}
Avg Price: ${position.avgPrice}
Curr Mark Price: ${position.markPrice}

Realized PnL: ${position.realizedPnl}
Unrealized PnL: ~${position.unrealizedPnl}`
}

export function getPlacedOrdersMsg(orderIds: string[], orderLinkIds: string[]) {
  return `
${orderIds.length === 1 ? `Order Id: ${orderIds[0]}` : `Order Ids: [${orderIds}]`}
${orderLinkIds.length === 1 ? `Order Link Id: ${orderLinkIds[0]}` : `Order Link Ids: [${orderLinkIds}]`}`
}