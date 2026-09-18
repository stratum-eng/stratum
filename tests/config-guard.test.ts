import { describe, expect, it } from "vitest";
import { entitlementsConfigError, repoDoConfigError } from "../src/middleware/config-guard";
import type { Env } from "../src/types";

const bucket = {} as Env["REPO_OBJECTS"];

describe("repoDoConfigError", () => {
  it("flags REPO_DO_ENABLED='true' with no REPO_OBJECTS bound", () => {
    const problem = repoDoConfigError({ REPO_DO_ENABLED: "true", REPO_OBJECTS: undefined });
    expect(problem).toContain("REPO_OBJECTS");
    expect(problem).toContain("REPO_DO_ENABLED");
  });

  it("is silent when the flag is on and the bucket is bound (staging)", () => {
    expect(repoDoConfigError({ REPO_DO_ENABLED: "true", REPO_OBJECTS: bucket })).toBeNull();
  });

  it("is silent when the flag is off, bound or not (production default)", () => {
    expect(repoDoConfigError({ REPO_DO_ENABLED: "false", REPO_OBJECTS: undefined })).toBeNull();
    expect(repoDoConfigError({ REPO_DO_ENABLED: undefined, REPO_OBJECTS: undefined })).toBeNull();
  });
});

describe("entitlementsConfigError", () => {
  it("flags ENTITLEMENTS_ENFORCE='1' with no billing service URL", () => {
    const problem = entitlementsConfigError({
      ENTITLEMENTS_ENFORCE: "1",
      BILLING_SERVICE_URL: undefined,
      BILLING_SERVICE_SECRET: "s3cret",
    });
    expect(problem).toContain("ENTITLEMENTS_ENFORCE");
    expect(problem).toContain("BILLING_SERVICE_URL");
    expect(problem).not.toContain("BILLING_SERVICE_SECRET is");
  });

  it("flags a missing BILLING_SERVICE_SECRET, which disables the seam just as silently", () => {
    // `entitlementsEnabled` requires BOTH. With the URL set and the secret
    // missing the seam reports itself off, every check returns inert, and an
    // operator who believes they switched enforcement on gets no signal at all
    // — which is precisely what this guard exists to prevent.
    const problem = entitlementsConfigError({
      ENTITLEMENTS_ENFORCE: "1",
      BILLING_SERVICE_URL: "https://billing.test",
      BILLING_SERVICE_SECRET: undefined,
    });
    expect(problem).toContain("BILLING_SERVICE_SECRET");
    expect(problem).toContain("every enforcement");
  });

  it("names both when both are missing", () => {
    const problem = entitlementsConfigError({
      ENTITLEMENTS_ENFORCE: "1",
      BILLING_SERVICE_URL: undefined,
      BILLING_SERVICE_SECRET: undefined,
    });
    expect(problem).toContain("BILLING_SERVICE_URL and BILLING_SERVICE_SECRET");
    expect(problem).toContain("are not set");
  });

  it("is silent when enforcement is on and the service is configured", () => {
    expect(
      entitlementsConfigError({
        ENTITLEMENTS_ENFORCE: "1",
        BILLING_SERVICE_URL: "https://billing.test",
        BILLING_SERVICE_SECRET: "s3cret",
      }),
    ).toBeNull();
  });

  it("is silent when enforcement is off, configured or not (the default)", () => {
    expect(
      entitlementsConfigError({ ENTITLEMENTS_ENFORCE: undefined, BILLING_SERVICE_URL: undefined }),
    ).toBeNull();
    expect(
      entitlementsConfigError({ ENTITLEMENTS_ENFORCE: "0", BILLING_SERVICE_URL: undefined }),
    ).toBeNull();
    // Only the exact "1" arms enforcement, so "true" is off — and off is coherent.
    expect(
      entitlementsConfigError({ ENTITLEMENTS_ENFORCE: "true", BILLING_SERVICE_URL: undefined }),
    ).toBeNull();
  });
});
