import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { type UseDataFunctionReturn, typedjson, useTypedLoaderData } from "remix-typedjson";
import { Spinner } from "~/components/primitives/Spinner";
import { TaskDetail } from "~/components/run/TaskDetail";
import { TaskDetailsPresenter } from "~/presenters/TaskDetailsPresenter.server";
import { requireUserId } from "~/services/session.server";
import { TaskParamsSchema } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { taskParam } = TaskParamsSchema.parse(params);

  const presenter = new TaskDetailsPresenter();
  const task = await presenter.call({
    userId,
    id: taskParam,
  });

  return typedjson({
    task,
  });
};

export type DetailedTask = NonNullable<UseDataFunctionReturn<typeof loader>["task"]>;

export default function Page() {
  const { task } = useTypedLoaderData<typeof loader>();

  if (!task) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return <TaskDetail task={task} />;
}
