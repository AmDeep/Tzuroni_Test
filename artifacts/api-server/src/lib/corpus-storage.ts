import { Storage } from "@google-cloud/storage";

// Standard Application Default Credentials: workload identity, an attached
// service account, or GOOGLE_APPLICATION_CREDENTIALS. No credentials in source.
export const corpusStorage = new Storage({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || "",
});
