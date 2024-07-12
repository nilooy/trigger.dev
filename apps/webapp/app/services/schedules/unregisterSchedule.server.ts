import { type PrismaClient, prisma } from "~/db.server";
import { type AuthenticatedEnvironment } from "../apiAuth.server";

export class UnregisterScheduleService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    environment,
    endpointSlug,
    id,
    key,
  }: {
    environment: AuthenticatedEnvironment;
    id: string;
    endpointSlug: string;
    key: string;
  }) {
    const endpoint = await this.#prismaClient.endpoint.findUniqueOrThrow({
      where: {
        environmentId_slug: {
          environmentId: environment.id,
          slug: endpointSlug,
        },
      },
    });

    const dynamicTrigger = await this.#prismaClient.dynamicTrigger.findUniqueOrThrow({
      where: {
        endpointId_slug_type: {
          endpointId: endpoint.id,
          slug: id,
          type: "SCHEDULE",
        },
      },
    });

    await this.#prismaClient.scheduleSource.update({
      where: {
        key_environmentId: {
          key,
          environmentId: environment.id,
        },
      },
      data: {
        active: false,
      },
    });
  }
}
