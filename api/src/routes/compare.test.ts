import { describe, expect, it } from "@jest/globals";
import express from "express";
import request from "supertest";
import compareRoutes, { compareEnabled } from "./compare.js";

// Version comparison (#23, ARCHITECTURE D21): the route exists only behind FEATURE_VERSION_COMPARE
// and answers 501 until versions are stored (#116). No database or Redis is needed here.
const NOT_IMPLEMENTED = 501;
const DOC = "7d6f1f8e-2f55-4c3e-9b8a-0a7e6c1d2b3f";
const V1 = "3b2a1c0d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const V2 = "5c4b3a2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";

const appWith = () => express().use("/api/v1/documents", compareRoutes);

describe("GET /api/v1/documents/:documentId/versions/:versionId/compare", () => {
  it("answers 501 NOT_IMPLEMENTED in the API's error shape until versions are stored", async () => {
    const res = await request(appWith()).get(`/api/v1/documents/${DOC}/versions/${V2}/compare?to=${V1}`);
    expect(res.status).toBe(NOT_IMPLEMENTED);
    expect(res.body).toEqual({ error: "Not Implemented", code: "NOT_IMPLEMENTED" });
  });
});

describe("compareEnabled", () => {
  it("is on only when FEATURE_VERSION_COMPARE is exactly 1", () => {
    expect(compareEnabled({ FEATURE_VERSION_COMPARE: "1" })).toBe(true);
    expect(compareEnabled({})).toBe(false);
    expect(compareEnabled({ FEATURE_VERSION_COMPARE: "true" })).toBe(false);
    expect(compareEnabled({ FEATURE_VERSION_COMPARE: "0" })).toBe(false);
  });
});
