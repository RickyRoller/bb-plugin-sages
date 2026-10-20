import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { envoyHostContract } from "./envoy-contract.ts";
import { prepareSource } from "./source-preparation.ts";

export default experimental_defineHostEntry({
  contract: envoyHostContract,
  handlers: {
    prepareSource: ({ path, installCommand }, { signal }) =>
      prepareSource(path, installCommand, signal),
  },
});
