import { type Logger } from "@trigger.dev/core-backend";
import type { PoolClient } from "pg";
import { type z } from "zod";
import { logger } from "~/services/logger.server";
import { safeJsonParse } from "~/utils/json";
import { type NotificationCatalog, type NotificationChannel, notificationCatalog } from "./types";

export class PgListenService {
  #poolClient: PoolClient;
  #logger: Logger;
  #loggerNamespace: string;

  constructor(poolClient: PoolClient, loggerNamespace?: string, loggerInstance?: Logger) {
    this.#poolClient = poolClient;
    this.#logger = loggerInstance ?? logger;
    this.#loggerNamespace = loggerNamespace ?? "";
  }

  public async on<TChannel extends NotificationChannel>(
    channelName: TChannel,
    callback: (payload: z.infer<NotificationCatalog[TChannel]>) => Promise<void>
  ) {
    this.#logDebug("Registering notification handler", { channelName });

    const isValidChannel = channelName.match(/^[a-zA-Z0-9:-_]+$/);

    if (!isValidChannel) {
      throw new Error(`Invalid channel name: ${channelName}`);
    }

    this.#poolClient.query(`LISTEN "${channelName}"`).then(null, (error) => {
      this.#logDebug("LISTEN error", error);
    });

    this.#poolClient.on("notification", async (notification) => {
      if (notification.channel !== channelName) {
        return;
      }

      this.#logDebug("Notification received", { notification });

      if (!notification.payload) {
        return;
      }

      const payload = safeJsonParse(notification.payload);

      const parsedPayload = notificationCatalog[channelName].safeParse(payload);

      if (!parsedPayload.success) {
        throw new Error(
          `Failed to parse notification payload: ${channelName} - ${JSON.stringify(
            parsedPayload.error
          )}`
        );
      }

      await callback(parsedPayload.data);
    });
  }

  #logDebug(message: string, args?: any) {
    const namespace = this.#loggerNamespace ? `[${this.#loggerNamespace}]` : "";
    this.#logger.debug(`[pgListen]${namespace} ${message}`, args);
  }
}
