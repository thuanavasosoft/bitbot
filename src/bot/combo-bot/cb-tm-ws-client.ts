class WsClient {
  client!: WebSocket;
  isConnecting: boolean = false;
  isConnected: boolean = false;
  private reconnectInterval?: NodeJS.Timeout;
  private pingInterval?: NodeJS.Timeout;

  private shouldSendMsgsAfterReconnect: string[] = [];

  constructor(private wsUrl: string) { }

  async connect(isReconnected = false): Promise<void> {
    if (this.isConnected || this.isConnecting) return;

    this.isConnecting = true;
    console.log("Connecting to ws server, url: ", this.wsUrl);
    let resolver: (p: unknown) => void;

    this.client = new WebSocket(this.wsUrl);
    if (this.reconnectInterval) {
      clearInterval(this.reconnectInterval);
    }

    this.client.addEventListener("open", () => {
      console.log("WebSocket connected");
      // Start sending ping messages
      this.pingInterval = setInterval(() => {
        if (this.client?.readyState === WebSocket.OPEN) {
          this.client.send(JSON.stringify({ type: "ping" }));
        }
      }, 3000);

      this.isConnected = true;

      if (isReconnected) {
        for (const msg of this.shouldSendMsgsAfterReconnect) {
          this.client.send(msg);
        }
      }

      resolver(1);
    });

    const handleCloseOrError = () => {
      console.log("WebSocket disconnected. Attempting to reconnect...");
      this.cleanup();
      this.scheduleReconnect();
    };

    this.client.addEventListener("close", handleCloseOrError);

    await new Promise(r => resolver = r);

    this.isConnecting = false;
  }

  sendMsg(msg: string, isShouldResendAfterReconnect?: boolean) {
    this.client.send(msg);
    if (isShouldResendAfterReconnect) this.shouldSendMsgsAfterReconnect.push(msg);
  }

  private cleanup() {
    this.isConnected = false;

    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = undefined;
    }

    if (this.reconnectInterval) {
      clearInterval(this.reconnectInterval);
      this.reconnectInterval = undefined;
    }

    if (this.client) {
      this.client.close();
    }
  }

  private scheduleReconnect() {
    if (this.reconnectInterval) return; // Avoid multiple timers

    this.reconnectInterval = setInterval(() => {
      console.log(`Reconnecting ${this.client?.readyState}`);
      if (this.client?.readyState !== WebSocket.OPEN) this.connect(true);
    }, 5000);
  }
}

export default WsClient;