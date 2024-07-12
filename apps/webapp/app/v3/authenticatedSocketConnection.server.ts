import { clientWebsocketMessages , serverWebsocketMessages } from '@trigger.dev/core/v3/schemas';
import { ZodMessageHandler, ZodMessageSender } from "@trigger.dev/core/v3/zodMessageHandler";
import { Evt } from "evt";
import { randomUUID } from "node:crypto";
import type { CloseEvent, ErrorEvent, MessageEvent, WebSocket } from "ws";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { DevQueueConsumer } from "./marqs/devQueueConsumer.server";

export class AuthenticatedSocketConnection {
  public id: string;
  public onClose: Evt<CloseEvent> = new Evt();

  private _sender: ZodMessageSender<typeof serverWebsocketMessages>;
  private _consumer: DevQueueConsumer;
  private _messageHandler: ZodMessageHandler<typeof clientWebsocketMessages>;

  constructor(
    public ws: WebSocket,
    public authenticatedEnv: AuthenticatedEnvironment,
    private readonly ipAddress: string | string[]
  ) {
    this.id = randomUUID();

    this._sender = new ZodMessageSender({
      schema: serverWebsocketMessages,
      sender: async (message) => {
        return new Promise((resolve, reject) => {
          if (!ws.OPEN) {
            return reject(new Error("Websocket is not open"));
          }

          ws.send(JSON.stringify(message), {}, (err) => {
            if (err) {
              reject(err);
              return;
            }

            resolve();
          });
        });
      },
    });

    this._consumer = new DevQueueConsumer(authenticatedEnv, this._sender, {
      ipAddress: Array.isArray(this.ipAddress) ? this.ipAddress.join(", ") : this.ipAddress,
    });

    ws.addEventListener("message", this.#handleMessage.bind(this));
    ws.addEventListener("close", this.#handleClose.bind(this));
    ws.addEventListener("error", this.#handleError.bind(this));

    this._messageHandler = new ZodMessageHandler({
      schema: clientWebsocketMessages,
      messages: {
        READY_FOR_TASKS: async (payload) => {
          await this._consumer.registerBackgroundWorker(
            payload.backgroundWorkerId,
            payload.inProgressRuns ?? []
          );
        },
        BACKGROUND_WORKER_DEPRECATED: async (payload) => {
          await this._consumer.deprecateBackgroundWorker(payload.backgroundWorkerId);
        },
        BACKGROUND_WORKER_MESSAGE: async (payload) => {
          switch (payload.data.type) {
            case "TASK_RUN_COMPLETED": {
              await this._consumer.taskAttemptCompleted(
                payload.backgroundWorkerId,
                payload.data.completion,
                payload.data.execution
              );
              break;
            }
            case "TASK_RUN_FAILED_TO_RUN": {
              await this._consumer.taskRunFailed(
                payload.backgroundWorkerId,
                payload.data.completion
              );

              break;
            }
            case "TASK_HEARTBEAT": {
              await this._consumer.taskHeartbeat(payload.backgroundWorkerId, payload.data.id);
              break;
            }
            case "TASK_RUN_HEARTBEAT": {
              await this._consumer.taskRunHeartbeat(payload.backgroundWorkerId, payload.data.id);
              break;
            }
          }
        },
      },
    });
  }

  async initialize() {
    this._sender.send("SERVER_READY", { id: this.id });
  }

  async #handleMessage(ev: MessageEvent) {
    const data = JSON.parse(ev.data.toString());

    await this._messageHandler.handleMessage(data);
  }

  async #handleClose(ev: CloseEvent) {
    logger.debug("[AuthenticatedSocketConnection] Websocket closed", { ev });

    await this._consumer.stop();

    const result = this.onClose.post(ev);

    logger.debug("[AuthenticatedSocketConnection] Called onClose", {
      result,
    });
  }

  async #handleError(ev: ErrorEvent) {
    logger.error("Websocket error", { ev });
  }
}
