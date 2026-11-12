import { ApiReference } from "@scalar/nextjs-api-reference";

const config = {
  url: "/api/v1/schema",
  pageTitle: "Captable API Docs",
  metaData: {
    title: "Captable API Docs",
    description: "Captable API Docs",
  },
};

export const GET = ApiReference(config);
