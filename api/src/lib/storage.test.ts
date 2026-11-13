import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { Readable } from "node:stream";

const send = jest.fn<(command: MockCommand) => Promise<unknown>>();
const done = jest.fn<() => Promise<unknown>>();
const uploadOptions = jest.fn<(options: Record<string, unknown>) => void>();

class MockCommand {
  input: Record<string, unknown>;

  constructor(input: Record<string, unknown>) {
    this.input = input;
  }
}

class MockUpload {
  constructor(options: Record<string, unknown>) {
    uploadOptions(options);
  }

  async done() {
    return done();
  }
}

// Mock the AWS SDK before importing the storage module.
jest.unstable_mockModule("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = send;
  },
  CopyObjectCommand: MockCommand,
  DeleteObjectCommand: MockCommand,
  GetObjectCommand: MockCommand,
}));

jest.unstable_mockModule("@aws-sdk/lib-storage", () => ({
  Upload: MockUpload,
}));

// Configure environment before storage.ts creates its S3 client.
process.env.SPACES_BUCKET = "test-bucket";
process.env.SPACES_ENDPOINT = "https://tor1.digitaloceanspaces.com";
process.env.SPACES_REGION = "tor1";
process.env.SPACES_KEY = "test-key";
process.env.SPACES_SECRET = "test-secret";

const { putStream, getStream, copy, remove } = await import("./storage.js");

afterEach(() => {
  send.mockReset();
  done.mockReset();
  uploadOptions.mockClear();
});

describe("Spaces storage", () => {
  it("uploads a stream using the multipart Upload helper", async () => {
    const stream = Readable.from(["document contents"]);
    done.mockResolvedValue({});

    await putStream("documents/doc-1/version-1", stream, "text/plain");

    expect(uploadOptions).toHaveBeenCalledWith({
      client: expect.anything(),
      params: {
        Bucket: "test-bucket",
        Key: "documents/doc-1/version-1",
        Body: stream,
        ContentType: "text/plain",
      },
    });

    expect(done).toHaveBeenCalledTimes(1);
  });

  it("propagates upload failures", async () => {
    done.mockRejectedValue(new Error("Upload failed"));

    await expect(
      putStream("documents/doc-1/version-1", Readable.from(["contents"]), "text/plain"),
    ).rejects.toThrow("Upload failed");
  });

  it("returns the readable stream from an object", async () => {
    const body = Readable.from(["document contents"]);
    send.mockResolvedValue({ Body: body });

    const result = await getStream("documents/doc-1/version-1");

    expect(result).toBe(body);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].input).toEqual({
      Bucket: "test-bucket",
      Key: "documents/doc-1/version-1",
    });
  });

  it("throws when an object has no response body", async () => {
    send.mockResolvedValue({ Body: undefined });

    await expect(getStream("documents/doc-1/version-1")).rejects.toThrow(
      "Object not found or empty: documents/doc-1/version-1",
    );
  });

  it("copies an object to a new key", async () => {
    send.mockResolvedValue({});

    await copy("documents/doc-1/version-1", "documents/doc-1/version-2");

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].input).toEqual({
      Bucket: "test-bucket",
      CopySource: "test-bucket/documents/doc-1/version-1",
      Key: "documents/doc-1/version-2",
    });
  });

  it("deletes an object", async () => {
    send.mockResolvedValue({});

    await remove("documents/doc-1/version-1");

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].input).toEqual({
      Bucket: "test-bucket",
      Key: "documents/doc-1/version-1",
    });
  });
});
