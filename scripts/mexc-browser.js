const WEBSOCKET_URL = "wss://ai4.draupnir.top";

// TRADE MODE
const LIMIT_TRADE_MODE_TAB_ID = "rc-tabs-4-tab-1";
const MARKET_TRADE_MODE_TAB_ID = "rc-tabs-4-tab-2";

// BUDGET_INPUT
const BUDGET_INPUT_SELECTOR = 'input.ant-input[type="text"][autocomplete="off"]';

// SHORT_BUTTONS
const OPEN_SHORT_BTN_LAPTOP_SELECTOR = '[data-testid="contract-trade-open-short-btn"]';
const OPEN_SHORT_BTN_MOBILE_SELECTOR = '[data-testid="contract-trade-mobile-close-btn"]';

// LONG_BUTTONS
const OPEN_LONG_BTN_LAPTOP_SELECTOR = '[data-testid="contract-trade-open-long-btn"]';
const OPEN_LONG_BTN_MOBILE_SELECTOR = '[data-testid="contract-trade-mobile-open-btn"]';

// CLOSE_POS_BUTTON
const CLOSE_CURRENT_POSITION_SELECTOR = '.ant-btn-v2.ant-btn-v2-tertiary.ant-btn-v2-sm.FastClose_flashCloseBtn__4uyRa.FastClose_closeBtn__XHnWi.FastClose_background__7pijv';

// POSITION_ORDERS_MENU
const OPENED_POSITION_TAB_ID = "rc-tabs-0-tab-1";
const OPEN_ORDERS_TAB_ID = "rc-tabs-0-tab-4";

const SWITCH_TAB_DELAY_IN_MS = 1;

const INPUT_LABEL_QUERY_SELECTOR = '.InputNumberHandle_extendTopWrapper__vfqsh span';
const INPUT_WRAPPER_QUERY_SELECTOR = '.component_numberInput__PF7Vf';

const OPEN_ORDER_ROW_QUERY_SELECTOR = 'tr.ant-table-row.ant-table-row-level-0';
const CANCEL_OPEN_ORDER_BTN_QUERY_SELECTOR = 'button.ant-btn-v2.ant-btn-v2-text.ant-btn-v2-md.position_operateBtn__y3e2M.position_chaseCancelBtn__zjBkZ';

async function openLongPosition(budgetAmt) {
  // Using querySelector with data-testid attribute selector
  let openLongBtn = document.querySelector(OPEN_LONG_BTN_LAPTOP_SELECTOR);
  if (!openLongBtn) {
    document.querySelector(OPEN_LONG_BTN_MOBILE_SELECTOR)?.click();
    openLongBtn = document.querySelector(OPEN_LONG_BTN_LAPTOP_SELECTOR);
  }
  await setMarketOrderBudgetAmtInput(budgetAmt);
  openLongBtn?.click();

  await switchPositionAndOrdersTab("openedPosition");
}


async function openShortPosition(budgetAmt) {
  // Using querySelector with data-testid attribute selector
  let openShortBtn = document.querySelector(OPEN_SHORT_BTN_LAPTOP_SELECTOR);
  if (!openShortBtn) {
    document.querySelector(OPEN_SHORT_BTN_MOBILE_SELECTOR)?.click();
    openShortBtn = document.querySelector(OPEN_SHORT_BTN_LAPTOP_SELECTOR);
  }
  await setMarketOrderBudgetAmtInput(budgetAmt);
  openShortBtn?.click();

  await switchPositionAndOrdersTab("openedPosition");
}


async function setMarketOrderBudgetAmtInput(value) {
  await switchTradeModeTab("market");
  // Try multiple selectors for robustness (AntD often adds extra classes)
  const budgetInput = document.querySelector(BUDGET_INPUT_SELECTOR);
  if (!budgetInput) {
    console.error("❌ Input element not found!");
    return;
  }

  setInputValue(budgetInput, value);
}

async function closeOpenedPosition() {
  await switchPositionAndOrdersTab("openedPosition");
  const closeOpenedLongPosBtn = document.querySelector(CLOSE_CURRENT_POSITION_SELECTOR);
  closeOpenedLongPosBtn?.click();
}

function setBudgetSlider(percent) {
  return new Promise((resolve) => {
    const slider = document.querySelector('.ant-slider');
    const handle = slider?.querySelector('.ant-slider-handle');
    if (!slider || !handle) return resolve();
    const rect = slider.getBoundingClientRect();
    const start = rect.left;
    const width = rect.width;
    const targetX = start + (width * percent / 100);
    const handleRect = handle.getBoundingClientRect();
    const currentX = handleRect.left + handleRect.width / 2;
    const steps = 20;
    const delay = 5;
    const deltaX = (targetX - currentX) / steps;
    const mouseDown = new MouseEvent('mousedown', {
      bubbles: true,
      clientX: currentX,
    });
    handle.dispatchEvent(mouseDown);
    let i = 0;
    function step() {
      if (i <= steps) {
        const moveEvent = new MouseEvent('mousemove', {
          bubbles: true,
          clientX: currentX + deltaX * i,
        });
        document.dispatchEvent(moveEvent);
        i++;
        setTimeout(step, delay);
      } else {
        const mouseUp = new MouseEvent('mouseup', {
          bubbles: true,
          clientX: targetX,
        });
        document.dispatchEvent(mouseUp);
        resolve(); // ✅ Done
      }
    }
    step();
  });
}

function startListenForWebsocket() {
  let wsClient = null;
  let reconnectInterval = null;
  let pingInterval = null;
  function connect() {
    wsClient = new WebSocket(WEBSOCKET_URL);
    if (reconnectInterval) {
      clearInterval(reconnectInterval);
    }
    wsClient.addEventListener("open", () => {
      console.warn("WebSocket connected");
      // Start sending ping messages
      pingInterval = setInterval(() => {
        if (wsClient?.readyState === WebSocket.OPEN) {
          wsClient.send(JSON.stringify({ type: "ping" }));
        }
      }, 3000);
    });
    wsClient.addEventListener("message", async (msg) => {
      const data = JSON.parse(msg.data);
      if (data.type === "open-long") {
        openLongPosition(data.openBalanceAmt);
      }


      if (data.type === "open-short") {
        openShortPosition(data.openBalanceAmt);
      }


      if (data.type === "close-position") {
        closeOpenedPosition();
      }


      if (data.type === "pong") {
        console.warn("Received pong msg");
      }
    });


    const handleCloseOrError = () => {
      console.warn("WebSocket disconnected. Attempting to reconnect...");
      cleanup();
      scheduleReconnect();
    };


    wsClient.addEventListener("close", handleCloseOrError);
    wsClient.addEventListener("error", handleCloseOrError);
  }


  function scheduleReconnect() {
    if (reconnectInterval) return; // Avoid multiple timers


    reconnectInterval = setInterval(() => {
      console.warn(`Reconnecting ${wsClient?.readyState}`);
      if (wsClient?.readyState !== WebSocket.OPEN) connect();
    }, 5000);
  }


  function cleanup() {
    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
    }


    if (reconnectInterval) {
      clearInterval(reconnectInterval);
      reconnectInterval = null;
    }


    if (wsClient) {
      try { wsClient.close(); } catch (_) { }
      wsClient = null;
    }
  }


  connect(); // Initial connection
}

/**
 * Sets the "Position and Orders" tab.
 * @param {"limit"|"market"} tradeMode - Indicates the trade mode to select: "limit" for opening Limit Orders, "market" for opening Market Orders.
 */
async function switchTradeModeTab(tradeMode) {
  const tabId = tradeMode.toLowerCase() === "limit" ? LIMIT_TRADE_MODE_TAB_ID : MARKET_TRADE_MODE_TAB_ID;
  const tab = document.getElementById(tabId);
  if (!tab) {
    console.error(`Tab with id "${tabId}" not found.`);
    return;
  }

  const isSelected = tab.getAttribute("aria-selected") === "true";
  if (isSelected) {
    console.warn(`Tab "${tabId}" is already active.`);
    return;
  }

  // Try to dispatch both native and React-compatible events
  const eventOptions = { bubbles: true, cancelable: true, view: window };

  ["mousedown", "mouseup", "click"].forEach((eventType) => {
    const event = new MouseEvent(eventType, eventOptions);
    tab.dispatchEvent(event);
  });

  await new Promise(r => setTimeout(r, SWITCH_TAB_DELAY_IN_MS));
  console.warn(`Tab "${tabId}" was not active, dispatched click events.`);
}

/**
 * Sets the "Position and Orders" tab.
 * @param {"openedPosition"|"openOrder"} tabMenu - Indicates the tab to select: "openedPosition" for Opened Positions, "openOrder" for Open Orders.
 */
async function switchPositionAndOrdersTab(tabMenu) {
  const tabId = tabMenu === "openedPosition" ? OPENED_POSITION_TAB_ID : OPEN_ORDERS_TAB_ID;
  const tab = document.getElementById(tabId);
  if (!tab) {
    console.error(`Tab with id "${tabId}" not found.`);
    return;
  }

  const isSelected = tab.getAttribute("aria-selected") === "true";
  if (isSelected) {
    console.warn(`Tab "${tabId}" is already active.`);
    return;
  }

  // Try to dispatch both native and React-compatible events
  const eventOptions = { bubbles: true, cancelable: true, view: window };

  ["mousedown", "mouseup", "click"].forEach((eventType) => {
    const event = new MouseEvent(eventType, eventOptions);
    tab.dispatchEvent(event);
  });

  await new Promise(r => setTimeout(r, SWITCH_TAB_DELAY_IN_MS));
  console.warn(`Tab "${tabId}" was not active, dispatched click events.`);
}

/**
 * @param {string} symbol
 * @param {"long" | "short"} orderSide
 * @param {number} leverage
 * @param {number} amount
 * @param {number} price
 */
function selectCorrectOpenOrderTr(symbol, orderSide, leverage, amount, price) {
  const rows = document.querySelectorAll(OPEN_ORDER_ROW_QUERY_SELECTOR);

  // Regex to extract fields from the <tr> text
  const rowRegex = /^(\S+).*?(buy|sell)\s+(long|short)\s+(\d+X)\s+([\d.]+)\s+usdt\s+([\d.]+)/i;

  for (const tr of rows) {
    const text = tr.innerText.replace(/\s+/g, ' ').trim().toLowerCase();
    const match = text.match(rowRegex);
    if (!match) continue;

    const rowSymbol = match[1];
    const rowOrderSide = `${match[2]} ${match[3]}`; // e.g., "Buy Long"
    const rowLeverage = match[4];
    const rowOrderAmt = match[5];
    const rowPrice = match[6];

    // Normalize everything to lowercase for comparison
    const isMatch =
      rowSymbol.includes(symbol.toLowerCase()) &&
      rowOrderSide.includes(orderSide.toLowerCase()) &&
      rowLeverage.includes(leverage.toString().toLowerCase()) &&
      Math.abs(parseFloat(rowOrderAmt) - parseFloat(amount)) < 0.0001 &&
      Math.abs(parseFloat(rowPrice) - parseFloat(price)) < 0.0001;


    if (isMatch) {
      return tr; // ✅ Found correct <tr>
    }
  }

  console.error('⚠️ No matching <tr> found.');
  return null;
}

/**
 * @param {string} symbol
 * @param {"long" | "short"} orderSide
 * @param {number} leverage
 * @param {number} amount
 * @param {number} price
 */
async function cancelOpenOrder(symbol, orderSide, leverage, amount, price) {
  await switchPositionAndOrdersTab("openOrder");
  const tr = selectCorrectOpenOrderTr(symbol, orderSide, leverage, amount, price);

  if (!tr) {
    console.error("Open Order TR not found couldn't cancel the ordrer");
    return;
  }

  const button = tr.querySelector(CANCEL_OPEN_ORDER_BTN_QUERY_SELECTOR);

  if (button) {
    button.click();
    console.warn('✅ Chase cancel button clicked!');
  } else {
    console.error('⚠️ Chase cancel button not found.');
  }
}

/**
 * @param {"long" | "short"} orderSide
 * @param {number} amount
 * @param {number} price
 */
async function openLimitOrder(orderSide, amount, price) {
  await switchTradeModeTab("limit");

  setLimitOrderPriceAndAmtValue(amount, price);

  let openPosBtn;
  if (orderSide.toLowerCase() === "short") {
    openPosBtn = document.querySelector(OPEN_SHORT_BTN_LAPTOP_SELECTOR);
  } else {
    openPosBtn = document.querySelector(OPEN_LONG_BTN_LAPTOP_SELECTOR);
  }

  openPosBtn.click();

  await switchPositionAndOrdersTab("openOrder");
}

function setLimitOrderPriceAndAmtValue(amount, price) {
  // Get all "number input" wrapper elements
  const allNumberInputs = document.querySelectorAll(INPUT_WRAPPER_QUERY_SELECTOR);

  let limitOrderPriceInput = null;
  let limitOrderAmountInput = null;

  allNumberInputs.forEach((wrapper) => {
    const label = wrapper.querySelector(INPUT_LABEL_QUERY_SELECTOR)?.innerText || '';
    if (label.includes('Price')) {
      limitOrderPriceInput = wrapper.querySelector('input');
    } else if (label.includes('Quantity') && label.includes('USDT')) {
      limitOrderAmountInput = wrapper.querySelector('input');
    }
  });

  // Update value here
  if (limitOrderPriceInput) {
    setInputValue(limitOrderPriceInput, price);
  }
  if (limitOrderAmountInput) {
    setInputValue(limitOrderAmountInput, amount);
  }
}

function setInputValue(input, value) {
  const lastValue = input.value;
  input.value = value;

  // Create a native input event that React can catch
  const event = new Event('input', { bubbles: true });

  // React uses an internal value tracker
  const tracker = input._valueTracker;
  if (tracker) {
    tracker.setValue(lastValue);
  }

  input.dispatchEvent(event);
}

startListenForWebsocket();
