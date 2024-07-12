import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { CreateBackgroundWorkerRequestBody } from '@trigger.dev/core/v3/schemas';
import { z } from "zod";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { CreateBackgroundWorkerService } from "~/v3/services/createBackgroundWorker.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid params" }, { status: 400 });
  }

  // Next authenticate the request
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    logger.info("Invalid or missing api key", { url: request.url });
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const authenticatedEnv = authenticationResult.environment;

  const { projectRef } = parsedParams.data;

  const rawBody = await request.json();
  const body = CreateBackgroundWorkerRequestBody.safeParse(rawBody);

  if (!body.success) {
    return json({ error: "Invalid body", issues: body.error.issues }, { status: 400 });
  }

  const service = new CreateBackgroundWorkerService();

  const backgroundWorker = await service.call(projectRef, authenticatedEnv, body.data);

  return json(
    {
      id: backgroundWorker.friendlyId,
      version: backgroundWorker.version,
      contentHash: backgroundWorker.contentHash,
    },
    { status: 200 }
  );
}
