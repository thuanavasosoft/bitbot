import amqp, { type Channel, type ChannelModel, type Options } from "amqplib";

export type MsgBrokerPublishFanoutOptions = {
  assertExchange?: Options.AssertExchange;
  publish?: Options.Publish;
};

const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

class CombMsgBrokerService {
  private static connection: ChannelModel | null = null;
  private static channel: Channel | null = null;
  private static connectPromise: Promise<void> | null = null;
  private static amqpUrl: string | undefined;
  /** After the first failed connection attempt with `AMQP_URL` set, no further connects are tried. */
  private static initialConnectAborted = false;
  /** Log "not configured" only once per process. */
  private static loggedMissingAmqpUrl = false;

  /** Exchanges already asserted on the current channel — avoids a round-trip on every publish. */
  private static assertedExchanges = new Set<string>();

  /**
   * Opens a connection and channel when `AMQP_URL` is set. The broker is optional: missing URL or a
   * failed first connection disables the service without throwing.
   */
  static async connect(): Promise<void> {
    const url = process.env.AMQP_URL?.trim();
    this.amqpUrl = url;
    if (!url) {
      if (!this.loggedMissingAmqpUrl) {
        this.loggedMissingAmqpUrl = true;
        console.info(
          "[Message broker]: not running — AMQP_URL is not set (optional; fanout publish is disabled).",
        );
      }
      return;
    }
    if (this.initialConnectAborted) {
      return;
    }
    if (this.channel) {
      return;
    }
    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }
    this.connectPromise = this.tryInitialConnect().finally(() => {
      this.connectPromise = null;
    });
    await this.connectPromise;
  }

  private static async tryInitialConnect(): Promise<void> {
    try {
      await this.doConnect();
      console.info("[Message broker]: running — connected to RabbitMQ.");
    } catch (err) {
      console.warn(
        "[Message broker]: not running — initial connection failed (optional; fanout publish is disabled). Running without RabbitMQ connection.",
        err,
      );
      this.initialConnectAborted = true;
    }
  }

  private static async doConnect(): Promise<void> {
    if (!this.amqpUrl) {
      return;
    }

    const connection = await amqp.connect(this.amqpUrl);
    const channel = await connection.createChannel();

    connection.on("error", (err: Error) => {
      console.error("AMQP connection error:", err);
    });
    connection.on("close", () => {
      if (this.connection === connection) {
        console.warn("AMQP connection closed — will reconnect on next publish");
        this.connection = null;
        this.channel = null;
        this.assertedExchanges.clear();
        void this.scheduleReconnect();
      }
    });

    this.connection = connection;
    this.channel = channel;
    this.assertedExchanges.clear();
  }

  /**
   * Retries `doConnect` with exponential backoff after an unexpected disconnect.
   * Stops once a connection is re-established.
   */
  private static async scheduleReconnect(): Promise<void> {
    for (const delay of RECONNECT_DELAYS_MS) {
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      if (this.channel) {
        return;
      }
      try {
        console.info(`AMQP reconnecting after ${delay}ms...`);
        await this.doConnect();
        console.info("[Message broker]: running — reconnected to RabbitMQ.");
        return;
      } catch (err) {
        console.error("AMQP reconnect attempt failed:", err);
      }
    }
    console.error("AMQP reconnect failed after all attempts — next publish will retry");
  }

  /**
   * Asserts a fanout exchange once per connection. Subsequent calls for the same
   * exchange name are no-ops (cached in `assertedExchanges`).
   */
  private static async ensureExchange(
    exchange: string,
    options?: Options.AssertExchange,
  ): Promise<void> {
    if (this.assertedExchanges.has(exchange)) {
      return;
    }
    const ch = this.channel;
    if (!ch) {
      throw new Error("AMQP channel is not available");
    }
    await ch.assertExchange(exchange, "fanout", options ?? { durable: true });
    this.assertedExchanges.add(exchange);
  }

  /**
   * Publishes to a fanout exchange so every bound queue (each subscriber) receives a copy.
   * Routing key is ignored for fanout. Use the same exchange name as consumers (e.g. AMQP_EXCHANGE).
   * Messages are persistent; paired with durable subscriber queues, consumers catch up after outages.
   */
  static async publishFanout(
    exchange: string,
    body: string | Buffer | object,
    options?: MsgBrokerPublishFanoutOptions,
  ): Promise<void> {
    await this.connect();
    const ch = this.channel;
    if (!ch) {
      return;
    }
    await this.ensureExchange(exchange, options?.assertExchange);

    const buffer =
      typeof body === "string"
        ? Buffer.from(body, "utf8")
        : Buffer.isBuffer(body)
          ? body
          : Buffer.from(JSON.stringify(body), "utf8");

    const ok = ch.publish(exchange, "", buffer, {
      persistent: true,
      ...options?.publish,
    });
    if (!ok) {
      await new Promise<void>((resolve, reject) => {
        ch.once("drain", resolve);
        ch.once("error", reject);
      });
    }
  }

  static async close(): Promise<void> {
    if (this.channel) {
      try {
        await this.channel.close();
      } catch {
        // channel may already be closed
      }
      this.channel = null;
    }
    if (this.connection) {
      try {
        await this.connection.close();
      } catch {
        // connection may already be closed
      }
      this.connection = null;
    }
    this.assertedExchanges.clear();
  }
}

export default CombMsgBrokerService;
