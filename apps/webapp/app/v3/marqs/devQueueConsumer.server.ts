import { type Context, ROOT_CONTEXT, type Span, SpanKind, context, trace } from "@opentelemetry/api";
import { type TaskRunExecution , type TaskRunExecutionLazyAttemptPayload , type TaskRunExecutionPayload , type TaskRunExecutionResult , type TaskRunFailedExecutionResult , type serverWebsocketMessages } from '@trigger.dev/core/v3/schemas';
import { type ZodMessageSender } from "@trigger.dev/core/v3/zodMessageHandler";
import { type BackgroundWorker, type BackgroundWorkerTask } from "@trigger.dev/database";
import { z } from "zod";
import { prisma } from "~/db.server";
import { createNewSession, disconnectSession } from "~/models/runtimeEnvironment.server";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { marqs, sanitizeQueueName } from "~/v3/marqs/index.server";
import { resolveVariablesForEnvironment } from "../environmentVariables/environmentVariablesRepository.server";
import { FailedTaskRunService } from "../failedTaskRun.server";
import { CancelTaskRunService } from "../services/cancelTaskRun.server";
import { CompleteAttemptService } from "../services/completeAttempt.server";
import { CreateTaskRunAttemptService } from "../services/createTaskRunAttempt.server";
import {
  SEMINTATTRS_FORCE_RECORDING,
  attributesFromAuthenticatedEnv,
  tracer,
} from "../tracer.server";
import { type DevSubscriber, devPubSub } from "./devPubSub.server";

const MessageBody = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("EXECUTE"),
    taskIdentifier: z.string(),
  }),
]);

type BackgroundWorkerWithTasks = BackgroundWorker & { tasks: BackgroundWorkerTask[] };

export type DevQueueConsumerOptions = {
  maximumItemsPerTrace?: number;
  traceTimeoutSeconds?: number;
  ipAddress?: string;
};

export class DevQueueConsumer {
  private _backgroundWorkers: Map<string, BackgroundWorkerWithTasks> = new Map();
  private _backgroundWorkerSubscriber: Map<string, DevSubscriber> = new Map();
  private _deprecatedWorkers: Map<string, BackgroundWorkerWithTasks> = new Map();
  private _enabled = false;
  private _maximumItemsPerTrace: number;
  private _traceTimeoutSeconds: number;
  private _perTraceCountdown: number | undefined;
  private _lastNewTrace: Date | undefined;
  private _currentSpanContext: Context | undefined;
  private _taskFailures: number = 0;
  private _taskSuccesses: number = 0;
  private _currentSpan: Span | undefined;
  private _endSpanInNextIteration = false;
  private _inProgressRuns: Map<string, string> = new Map(); // Keys are task run friendly IDs, values are TaskRun internal ids/queue message ids

  constructor(
    public env: AuthenticatedEnvironment,
    private _sender: ZodMessageSender<typeof serverWebsocketMessages>,
    private _options: DevQueueConsumerOptions = {}
  ) {
    this._traceTimeoutSeconds = _options.traceTimeoutSeconds ?? 60;
    this._maximumItemsPerTrace = _options.maximumItemsPerTrace ?? 1_000;
  }

  // This method is called when a background worker is deprecated and will no longer be used unless a run is locked to it
  public async deprecateBackgroundWorker(id: string) {
    const backgroundWorker = this._backgroundWorkers.get(id);

    if (!backgroundWorker) {
      return;
    }

    this._deprecatedWorkers.set(id, backgroundWorker);
    this._backgroundWorkers.delete(id);
  }

  public async registerBackgroundWorker(id: string, inProgressRuns: string[] = []) {
    const backgroundWorker = await prisma.backgroundWorker.findUnique({
      where: { friendlyId: id, runtimeEnvironmentId: this.env.id },
      include: {
        tasks: true,
      },
    });

    if (!backgroundWorker) {
      return;
    }

    if (this._backgroundWorkers.has(backgroundWorker.id)) {
      return;
    }

    this._backgroundWorkers.set(backgroundWorker.id, backgroundWorker);

    logger.debug("Registered background worker", {
      backgroundWorker: backgroundWorker.id,
      inProgressRuns,
    });

    const subscriber = await devPubSub.subscribe(`backgroundWorker:${backgroundWorker.id}:*`);

    subscriber.on("CANCEL_ATTEMPT", async (message) => {
      await this._sender.send("BACKGROUND_WORKER_MESSAGE", {
        backgroundWorkerId: backgroundWorker.friendlyId,
        data: {
          type: "CANCEL_ATTEMPT",
          taskAttemptId: message.attemptId,
          taskRunId: message.taskRunId,
        },
      });
    });

    this._backgroundWorkerSubscriber.set(backgroundWorker.id, subscriber);

    for (const runId of inProgressRuns) {
      this._inProgressRuns.set(runId, runId);
    }

    // Start reading from the queue if we haven't already
    await this.#enable();
  }

  public async taskAttemptCompleted(
    workerId: string,
    completion: TaskRunExecutionResult,
    execution: TaskRunExecution
  ) {
    if (completion.ok) {
      this._taskSuccesses++;
    } else {
      this._taskFailures++;
    }

    logger.debug("[DevQueueConsumer] taskAttemptCompleted()", {
      taskRunCompletion: completion,
      execution,
    });

    const service = new CompleteAttemptService();
    const result = await service.call({ completion, execution, env: this.env });

    if (result === "COMPLETED") {
      this._inProgressRuns.delete(execution.run.id);
    }
  }

  public async taskRunFailed(workerId: string, completion: TaskRunFailedExecutionResult) {
    this._taskFailures++;

    logger.debug("[DevQueueConsumer] taskRunFailed()", { completion });

    this._inProgressRuns.delete(completion.id);

    const service = new FailedTaskRunService();

    await service.call(completion.id, completion);
  }

  /**
   * @deprecated Use `taskRunHeartbeat` instead
   */
  public async taskHeartbeat(workerId: string, id: string, seconds: number = 60) {
    logger.debug("[DevQueueConsumer] taskHeartbeat()", { id, seconds });

    const taskRunAttempt = await prisma.taskRunAttempt.findUnique({
      where: { friendlyId: id },
    });

    if (!taskRunAttempt) {
      return;
    }

    await marqs?.heartbeatMessage(taskRunAttempt.taskRunId, seconds);
  }

  public async taskRunHeartbeat(workerId: string, id: string, seconds: number = 60) {
    logger.debug("[DevQueueConsumer] taskRunHeartbeat()", { id, seconds });

    await marqs?.heartbeatMessage(id, seconds);
  }

  public async stop(reason: string = "CLI disconnected") {
    if (!this._enabled) {
      return;
    }

    logger.debug("Stopping dev queue consumer", { env: this.env });

    this._enabled = false;

    // Create the session
    await disconnectSession(this.env.id);

    // We need to cancel all the in progress task run attempts and ack the messages so they will stop processing
    await this.#cancelInProgressRunsAndAttempts(reason);

    // We need to unsubscribe from the background worker channels
    for (const [id, subscriber] of this._backgroundWorkerSubscriber) {
      logger.debug("Unsubscribing from background worker channel", { id });

      await subscriber.stopListening();
      this._backgroundWorkerSubscriber.delete(id);

      logger.debug("Unsubscribed from background worker channel", { id });
    }

    // We need to end the current span
    if (this._currentSpan) {
      this._currentSpan.end();
    }
  }

  async #cancelInProgressRunsAndAttempts(reason: string) {
    const cancelTaskRunService = new CancelTaskRunService();

    const cancelledAt = new Date();

    const inProgressRuns = new Map(this._inProgressRuns);

    this._inProgressRuns.clear();

    logger.debug("Cancelling in progress runs and attempts", {
      runs: Array.from(inProgressRuns.keys()),
    });

    for (const [_, runId] of inProgressRuns) {
      await this.#cancelInProgressRun(runId, cancelTaskRunService, cancelledAt, reason);
    }
  }

  async #cancelInProgressRun(
    runId: string,
    service: CancelTaskRunService,
    cancelledAt: Date,
    reason: string
  ) {
    logger.debug("Cancelling in progress run", { runId });

    const taskRun = runId.startsWith("run_")
      ? await prisma.taskRun.findUnique({
          where: { friendlyId: runId },
        })
      : await prisma.taskRun.findUnique({
          where: { id: runId },
        });

    if (!taskRun) {
      return;
    }

    try {
      await service.call(taskRun, { reason, cancelAttempts: true, cancelledAt });
    } catch (e) {
      logger.error("Failed to cancel in progress run", {
        runId,
        error: e,
      });
    }
  }

  async #enable() {
    if (this._enabled) {
      return;
    }

    this._enabled = true;
    // Create the session
    await createNewSession(this.env, this._options.ipAddress ?? "unknown");

    this._perTraceCountdown = this._options.maximumItemsPerTrace;
    this._lastNewTrace = new Date();
    this._taskFailures = 0;
    this._taskSuccesses = 0;

    this.#doWork().finally(() => {});
  }

  async #doWork() {
    if (!this._enabled) {
      return;
    }

    // Check if the trace has expired
    if (
      this._perTraceCountdown === 0 ||
      Date.now() - this._lastNewTrace!.getTime() > this._traceTimeoutSeconds * 1000 ||
      this._currentSpanContext === undefined ||
      this._endSpanInNextIteration
    ) {
      if (this._currentSpan) {
        this._currentSpan.setAttribute("tasks.period.failures", this._taskFailures);
        this._currentSpan.setAttribute("tasks.period.successes", this._taskSuccesses);

        logger.debug("Ending DevQueueConsumer.doWork() trace", {
          isRecording: this._currentSpan.isRecording(),
        });

        this._currentSpan.end();
      }

      // Create a new trace
      this._currentSpan = tracer.startSpan(
        "DevQueueConsumer.doWork()",
        {
          kind: SpanKind.CONSUMER,
          attributes: {
            ...attributesFromAuthenticatedEnv(this.env),
            [SEMINTATTRS_FORCE_RECORDING]: true,
          },
        },
        ROOT_CONTEXT
      );

      // Get the span trace context
      this._currentSpanContext = trace.setSpan(ROOT_CONTEXT, this._currentSpan);

      this._perTraceCountdown = this._options.maximumItemsPerTrace;
      this._lastNewTrace = new Date();
      this._taskFailures = 0;
      this._taskSuccesses = 0;
      this._endSpanInNextIteration = false;
    }

    return context.with(this._currentSpanContext ?? ROOT_CONTEXT, async () => {
      await this.#doWorkInternal();
      this._perTraceCountdown = this._perTraceCountdown! - 1;
    });
  }

  async #doWorkInternal() {
    // Attempt to dequeue a message from the environment's queue
    // If no message is available, reschedule the worker to run again in 1 second
    // If a message is available, find the BackgroundWorkerTask that matches the message's taskIdentifier
    // If no matching task is found, nack the message and reschedule the worker to run again in 1 second
    // If the matching task is found, create the task attempt and lock the task run, then send the task run to the client
    // Store the message as a processing message
    // If the websocket connection disconnects before the task run is completed, nack the message
    // When the task run completes, ack the message
    // Using a heartbeat mechanism, if the client keeps responding with a heartbeat, we'll keep the message processing and increase the visibility timeout.

    const message = await marqs?.dequeueMessageInEnv(this.env);

    if (!message) {
      setTimeout(() => this.#doWork(), 1000);
      return;
    }

    const messageBody = MessageBody.safeParse(message.data);

    if (!messageBody.success) {
      logger.error("Failed to parse message", {
        queueMessage: message.data,
        error: messageBody.error,
        env: this.env,
      });

      await marqs?.acknowledgeMessage(message.messageId);

      setTimeout(() => this.#doWork(), 100);
      return;
    }

    const existingTaskRun = await prisma.taskRun.findUnique({
      where: {
        id: message.messageId,
      },
    });

    if (!existingTaskRun) {
      await marqs?.acknowledgeMessage(message.messageId);
      setTimeout(() => this.#doWork(), 100);
      return;
    }

    const backgroundWorker = existingTaskRun.lockedToVersionId
      ? this._deprecatedWorkers.get(existingTaskRun.lockedToVersionId) ??
        this._backgroundWorkers.get(existingTaskRun.lockedToVersionId)
      : this.#getLatestBackgroundWorker();

    if (!backgroundWorker) {
      await marqs?.acknowledgeMessage(message.messageId);
      setTimeout(() => this.#doWork(), 100);
      return;
    }

    const backgroundTask = backgroundWorker.tasks.find(
      (task) => task.slug === existingTaskRun.taskIdentifier
    );

    if (!backgroundTask) {
      logger.warn("No matching background task found for task run", {
        taskRun: existingTaskRun.id,
        taskIdentifier: existingTaskRun.taskIdentifier,
        backgroundWorker: backgroundWorker.id,
        taskSlugs: backgroundWorker.tasks.map((task) => task.slug),
      });

      await marqs?.acknowledgeMessage(message.messageId);

      setTimeout(() => this.#doWork(), 100);
      return;
    }

    const lockedTaskRun = await prisma.taskRun.update({
      where: {
        id: message.messageId,
      },
      data: {
        lockedAt: new Date(),
        lockedById: backgroundTask.id,
        status: "EXECUTING",
        lockedToVersionId: backgroundWorker.id,
        startedAt: existingTaskRun.startedAt ?? new Date(),
      },
      include: {
        attempts: {
          take: 1,
          orderBy: { number: "desc" },
        },
        tags: true,
        batchItems: {
          include: {
            batchTaskRun: true,
          },
        },
      },
    });

    if (!lockedTaskRun) {
      logger.warn("Failed to lock task run", {
        taskRun: existingTaskRun.id,
        taskIdentifier: existingTaskRun.taskIdentifier,
        backgroundWorker: backgroundWorker.id,
        messageId: message.messageId,
      });

      await marqs?.acknowledgeMessage(message.messageId);

      setTimeout(() => this.#doWork(), 100);
      return;
    }

    const queue = await prisma.taskQueue.findUnique({
      where: {
        runtimeEnvironmentId_name: {
          runtimeEnvironmentId: this.env.id,
          name: sanitizeQueueName(lockedTaskRun.queue),
        },
      },
    });

    if (!queue) {
      logger.debug("[DevQueueConsumer] Failed to find queue", {
        queueName: lockedTaskRun.queue,
        sanitizedName: sanitizeQueueName(lockedTaskRun.queue),
        taskRun: lockedTaskRun.id,
        messageId: message.messageId,
      });

      await marqs?.nackMessage(message.messageId);
      setTimeout(() => this.#doWork(), 1000);
      return;
    }

    if (!this._enabled) {
      logger.debug("Dev queue consumer is disabled", { env: this.env, queueMessage: message });

      await marqs?.nackMessage(message.messageId);
      return;
    }

    const variables = await resolveVariablesForEnvironment(this.env);

    if (backgroundWorker.supportsLazyAttempts) {
      const payload: TaskRunExecutionLazyAttemptPayload = {
        traceContext: lockedTaskRun.traceContext as Record<string, unknown>,
        environment: variables.reduce((acc: Record<string, string>, curr) => {
          acc[curr.key] = curr.value;
          return acc;
        }, {}),
        runId: lockedTaskRun.friendlyId,
        messageId: lockedTaskRun.id,
        isTest: lockedTaskRun.isTest,
      };

      try {
        await this._sender.send("BACKGROUND_WORKER_MESSAGE", {
          backgroundWorkerId: backgroundWorker.friendlyId,
          data: {
            type: "EXECUTE_RUN_LAZY_ATTEMPT",
            payload,
          },
        });

        logger.debug("Executing the run", {
          messageId: message.messageId,
        });

        this._inProgressRuns.set(lockedTaskRun.friendlyId, message.messageId);
      } catch (e) {
        if (e instanceof Error) {
          this._currentSpan?.recordException(e);
        } else {
          this._currentSpan?.recordException(new Error(String(e)));
        }

        this._endSpanInNextIteration = true;

        // We now need to unlock the task run and delete the task run attempt
        await prisma.$transaction([
          prisma.taskRun.update({
            where: {
              id: lockedTaskRun.id,
            },
            data: {
              lockedAt: null,
              lockedById: null,
              status: "PENDING",
              startedAt: existingTaskRun.startedAt,
            },
          }),
        ]);

        this._inProgressRuns.delete(lockedTaskRun.friendlyId);

        // Finally we need to nack the message so it can be retried
        await marqs?.nackMessage(message.messageId);
      } finally {
        setTimeout(() => this.#doWork(), 100);
      }
    } else {
      const service = new CreateTaskRunAttemptService();
      const { execution } = await service.call(lockedTaskRun.friendlyId, this.env);

      const payload: TaskRunExecutionPayload = {
        traceContext: lockedTaskRun.traceContext as Record<string, unknown>,
        environment: variables.reduce((acc: Record<string, string>, curr) => {
          acc[curr.key] = curr.value;
          return acc;
        }, {}),
        execution,
      };

      try {
        await this._sender.send("BACKGROUND_WORKER_MESSAGE", {
          backgroundWorkerId: backgroundWorker.friendlyId,
          data: {
            type: "EXECUTE_RUNS",
            payloads: [payload],
          },
        });

        logger.debug("Executing the run", {
          messageId: message.messageId,
        });

        this._inProgressRuns.set(lockedTaskRun.friendlyId, message.messageId);
      } catch (e) {
        if (e instanceof Error) {
          this._currentSpan?.recordException(e);
        } else {
          this._currentSpan?.recordException(new Error(String(e)));
        }

        this._endSpanInNextIteration = true;

        // We now need to unlock the task run and delete the task run attempt
        await prisma.$transaction([
          prisma.taskRun.update({
            where: {
              id: lockedTaskRun.id,
            },
            data: {
              lockedAt: null,
              lockedById: null,
              status: "PENDING",
              startedAt: existingTaskRun.startedAt,
            },
          }),
        ]);

        this._inProgressRuns.delete(lockedTaskRun.friendlyId);

        // Finally we need to nack the message so it can be retried
        await marqs?.nackMessage(message.messageId);
      } finally {
        setTimeout(() => this.#doWork(), 100);
      }
    }
  }

  // Get the latest background worker based on the version.
  // Versions are in the format of 20240101.1 and 20240101.2, or even 20240101.10, 20240101.11, etc.
  #getLatestBackgroundWorker() {
    const workers = Array.from(this._backgroundWorkers.values());

    if (workers.length === 0) {
      return;
    }

    return workers.reduce((acc, curr) => {
      const accParts = acc.version.split(".").map(Number);
      const currParts = curr.version.split(".").map(Number);

      // Compare the major part
      if (accParts[0] < currParts[0]) {
        return curr;
      } else if (accParts[0] > currParts[0]) {
        return acc;
      }

      // Compare the minor part (assuming all versions have two parts)
      if (accParts[1] < currParts[1]) {
        return curr;
      } else {
        return acc;
      }
    });
  }
}
