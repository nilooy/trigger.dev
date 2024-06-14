import { Options, defineConfig as defineConfigTSUP } from "tsup";
import { packageOptions } from "@trigger.dev/tsup";

const options: Options = {
  ...packageOptions,
  entry: ["./src/index.ts", "./src/v3/index.ts", "./src/v3/unstable-core-do-not-import.ts"],
};

export default defineConfigTSUP(options);
