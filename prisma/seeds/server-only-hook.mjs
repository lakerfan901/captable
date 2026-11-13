// Lets the LLC governance seed (llc-governance.ts) load server modules under
// plain Node, which Next normally bundles: `server-only` (a Next marker
// package, not installed) resolves to an empty module, and the CommonJS
// `next-auth/providers/*` modules get their real default export. Must be
// imported BEFORE the seed module (index.ts imports both dynamically).
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
