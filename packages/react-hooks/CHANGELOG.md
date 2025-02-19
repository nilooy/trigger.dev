# @trigger.dev/react-hooks

## 3.3.0

### Minor Changes

- Improved Batch Triggering: ([#1502](https://github.com/triggerdotdev/trigger.dev/pull/1502))

  - The new Batch Trigger endpoint is now asynchronous and supports up to 500 runs per request.
  - The new endpoint also supports triggering multiple different tasks in a single batch request (support in the SDK coming soon).
  - The existing `batchTrigger` method now supports the new endpoint, and shouldn't require any changes to your code.

  - Idempotency keys now expire after 24 hours, and you can customize the expiration time when creating a new key by using the `idempotencyKeyTTL` parameter:

  ```ts
  await myTask.batchTrigger([{ payload: { foo: "bar" } }], {
    idempotencyKey: "my-key",
    idempotencyKeyTTL: "60s",
  });
  // Works for individual items as well:
  await myTask.batchTrigger([
    { payload: { foo: "bar" }, options: { idempotencyKey: "my-key", idempotencyKeyTTL: "60s" } },
  ]);
  // And `trigger`:
  await myTask.trigger({ foo: "bar" }, { idempotencyKey: "my-key", idempotencyKeyTTL: "60s" });
  ```

  ### Breaking Changes

  - We've removed the `idempotencyKey` option from `triggerAndWait` and `batchTriggerAndWait`, because it can lead to permanently frozen runs in deployed tasks. We're working on upgrading our entire system to support idempotency keys on these methods, and we'll re-add the option once that's complete.

### Patch Changes

- Added ability to subscribe to a batch of runs using runs.subscribeToBatch ([#1502](https://github.com/triggerdotdev/trigger.dev/pull/1502))
- Updated dependencies:
  - `@trigger.dev/core@3.3.0`

## 3.2.2

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.2.2`

## 3.2.1

### Patch Changes

- React hooks now all accept accessToken and baseURL options so the use of the Provider is no longer necessary ([#1486](https://github.com/triggerdotdev/trigger.dev/pull/1486))
- Upgrade zod to latest (3.23.8) ([#1484](https://github.com/triggerdotdev/trigger.dev/pull/1484))
- Realtime streams ([#1470](https://github.com/triggerdotdev/trigger.dev/pull/1470))
- Updated dependencies:
  - `@trigger.dev/core@3.2.1`

## 3.2.0

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.2.0`

## 3.1.2

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.1.2`

## 3.1.1

### Patch Changes

- useBatch renamed to useRealtimeBatch ([#1447](https://github.com/triggerdotdev/trigger.dev/pull/1447))
- Updated dependencies:
  - `@trigger.dev/core@3.1.1`

## 3.1.0

### Minor Changes

- Access run status updates in realtime, from your server or from your frontend ([#1402](https://github.com/triggerdotdev/trigger.dev/pull/1402))

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.1.0`
