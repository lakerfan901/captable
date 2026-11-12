// Loaded with `--import` by ledger.integration.ts so server code can run
// under plain Node (Next normally bundles it):
// - `server-only` (a Next marker package, not installed) resolves to an empty
//   module;
// - `next-auth/providers/*` are CommonJS modules whose default export Node
//   wraps once more; re-export their real default.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { url: "data:text/javascript,", shortCircuit: true };
    }
    if (
      specifier.startsWith("next-auth/providers/") &&
      !context.parentURL?.startsWith("data:")
    ) {
      const real = nextResolve(specifier, context);
      const source = `import m from ${JSON.stringify(real.url)}; export default (m && m.default) || m;`;
      return {
        url: `data:text/javascript,${encodeURIComponent(source)}`,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
