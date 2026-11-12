import { unstable_noStore as noStore } from "next/cache";
import Script from "next/script";
import { PUBLIC_ENV_KEY } from "@/constants/env";
import { getPublicEnv } from "@/lib/env";

export function PublicEnvScript() {
  noStore();
  const publicEnvs = JSON.stringify(getPublicEnv());
  return (
    <Script
      strategy="beforeInteractive"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: inlines server-serialized public env JSON, no user input
      dangerouslySetInnerHTML={{
        __html: `window.${PUBLIC_ENV_KEY} = ${publicEnvs}`,
      }}
    />
  );
}
