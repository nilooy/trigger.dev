import { WorkerInstanceGroup, WorkerInstanceGroupType } from "@trigger.dev/database";
import { WithRunEngine } from "../baseService.server";
import { WorkerGroupTokenService } from "./workerGroupTokenService.server";
import { logger } from "~/services/logger.server";
import { makeFlags } from "~/v3/featureFlags.server";

export class WorkerGroupService extends WithRunEngine {
  private readonly defaultNamePrefix = "worker_group";

  async createWorkerGroup({
    projectId,
    organizationId,
    name,
    description,
    type,
  }: {
    projectId?: string;
    organizationId?: string;
    name?: string;
    description?: string;
    type?: WorkerInstanceGroupType;
  }) {
    name = name ?? (await this.generateWorkerName({ projectId }));

    const tokenService = new WorkerGroupTokenService({
      prisma: this._prisma,
      engine: this._engine,
    });
    const token = await tokenService.createToken();

    const workerGroup = await this._prisma.workerInstanceGroup.create({
      data: {
        projectId,
        organizationId,
        type: projectId
          ? WorkerInstanceGroupType.UNMANAGED
          : type ?? WorkerInstanceGroupType.SHARED,
        masterQueue: this.generateMasterQueueName({ projectId, name }),
        tokenId: token.id,
        description,
        name,
      },
    });

    return {
      workerGroup,
      token,
    };
  }

  async updateWorkerGroup({
    projectId,
    workerGroupId,
    name,
    description,
  }: {
    projectId: string;
    workerGroupId: string;
    name?: string;
    description?: string;
  }) {
    const workerGroup = await this._prisma.workerInstanceGroup.findUnique({
      where: {
        id: workerGroupId,
        projectId,
      },
    });

    if (!workerGroup) {
      logger.error("[WorkerGroupService] No worker group found for update", {
        workerGroupId,
        name,
        description,
      });
      return;
    }

    await this._prisma.workerInstanceGroup.update({
      where: {
        id: workerGroup.id,
      },
      data: {
        description,
        name,
      },
    });
  }

  async listWorkerGroups({ projectId }: { projectId?: string }) {
    const workerGroups = await this._prisma.workerInstanceGroup.findMany({
      where: {
        OR: [
          {
            type: WorkerInstanceGroupType.SHARED,
          },
          {
            projectId,
          },
        ],
      },
    });

    return workerGroups;
  }

  async deleteWorkerGroup({
    projectId,
    workerGroupId,
  }: {
    projectId: string;
    workerGroupId: string;
  }) {
    const workerGroup = await this._prisma.workerInstanceGroup.findUnique({
      where: {
        id: workerGroupId,
      },
    });

    if (!workerGroup) {
      logger.error("[WorkerGroupService] WorkerGroup not found for deletion", {
        workerGroupId,
        projectId,
      });
      return;
    }

    if (workerGroup.projectId !== projectId) {
      logger.error("[WorkerGroupService] WorkerGroup does not belong to project", {
        workerGroupId,
        projectId,
      });
      return;
    }

    await this._prisma.workerInstanceGroup.delete({
      where: {
        id: workerGroupId,
      },
    });
  }

  async getGlobalDefaultWorkerGroup() {
    const flags = makeFlags(this._prisma);

    const defaultWorkerInstanceGroupId = await flags({
      key: "defaultWorkerInstanceGroupId",
    });

    if (!defaultWorkerInstanceGroupId) {
      logger.error("[WorkerGroupService] Default worker group not found in feature flags");
      return;
    }

    const workerGroup = await this._prisma.workerInstanceGroup.findUnique({
      where: {
        id: defaultWorkerInstanceGroupId,
      },
    });

    if (!workerGroup) {
      logger.error("[WorkerGroupService] Default worker group not found", {
        defaultWorkerInstanceGroupId,
      });
      return;
    }

    return workerGroup;
  }

  async getDefaultWorkerGroupForProject({
    projectId,
  }: {
    projectId: string;
  }): Promise<WorkerInstanceGroup | undefined> {
    const project = await this._prisma.project.findUnique({
      where: {
        id: projectId,
      },
      include: {
        defaultWorkerGroup: true,
      },
    });

    if (!project) {
      logger.error("[WorkerGroupService] Project not found", { projectId });
      return;
    }

    if (project.defaultWorkerGroup) {
      return project.defaultWorkerGroup;
    }

    return await this.getGlobalDefaultWorkerGroup();
  }

  async setDefaultWorkerGroupForProject({
    projectId,
    workerGroupId,
  }: {
    projectId: string;
    workerGroupId: string;
  }) {
    const workerGroup = await this._prisma.workerInstanceGroup.findUnique({
      where: {
        id: workerGroupId,
      },
    });

    if (!workerGroup) {
      logger.error("[WorkerGroupService] WorkerGroup not found", {
        workerGroupId,
      });
      return;
    }

    await this._prisma.project.update({
      where: {
        id: projectId,
      },
      data: {
        defaultWorkerGroupId: workerGroupId,
      },
    });
  }

  private async generateWorkerName({ projectId }: { projectId?: string }) {
    const workerGroups = await this._prisma.workerInstanceGroup.count({
      where: {
        projectId: projectId ?? null,
      },
    });

    return `${this.defaultNamePrefix}_${workerGroups + 1}`;
  }

  private generateMasterQueueName({ projectId, name }: { projectId?: string; name: string }) {
    if (!projectId) {
      return name;
    }

    return `${projectId}-${name}`;
  }
}
