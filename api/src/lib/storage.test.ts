import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { Readable } from "node:stream";

const send = jest.fn<(command: MockCommand) => Promise<unknown>>();
const done = jest.fn<() => Promise<unknown>>();
const uploadOptions = jest.fn<(options: Record<string, unknown>) => void>();
const abort = jest.fn<() => Promise<void>>();
const s3ClientOptions = jest.fn<(options: Record<string, unknown>) => void>();

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

  async abort() {
    return abort();
  }
}

// Mock the AWS SDK before importing the storage module.
jest.unstable_mockModule("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = send;

    constructor(options: Record<string, unknown>) {
      s3ClientOptions(options);
    }
  },
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

const { putStream, getStream, remove, StorageNotFoundError, validateStorageConfig } =
  await import("./storage.js");
afterEach(() => {
  send.mockReset();
  done.mockReset();
  uploadOptions.mockClear();
});

describe("Spaces storage", () => {
  it("validates required Spaces configuration", () => {
    expect(() => validateStorageConfig()).not.toThrow();

    const requiredVariables = [
      "SPACES_ENDPOINT",
      "SPACES_REGION",
      "SPACES_BUCKET",
      "SPACES_KEY",
      "SPACES_SECRET",
    ] as const;

    for (const variable of requiredVariables) {
      const originalValue = process.env[variable];

      try {
        delete process.env[variable];

        expect(() => validateStorageConfig()).toThrow(
          `Missing required Spaces configuration: ${variable}`,
        );
      } finally {
        if (originalValue !== undefined) {
          process.env[variable] = originalValue;
        }
      }
    }
  });
  it("throws when the Spaces bucket is not configured", async () => {
    const originalBucket = process.env.SPACES_BUCKET;
    delete process.env.SPACES_BUCKET;

    try {
      await expect(remove("documents/doc-1/version-1")).rejects.toThrow(
        "SPACES_BUCKET is not configured",
      );
    } finally {
      if (originalBucket === undefined) {
        delete process.env.SPACES_BUCKET;
      } else {
        process.env.SPACES_BUCKET = originalBucket;
      }
    }
  });

  it("configures the S3 client using Spaces environment variables", () => {
    const options = s3ClientOptions.mock.calls[0]?.[0];

    expect(options).toMatchObject({
      endpoint: "https://tor1.digitaloceanspaces.com",
      region: "tor1",
      credentials: {
        accessKeyId: "test-key",
        secretAccessKey: "test-secret",
      },
    });
  });

  it("maps a missing object error to StorageNotFoundError", async () => {
    const error = new Error("The specified key does not exist.");
    error.name = "NoSuchKey";

    send.mockRejectedValue(error);

    const result = getStream("documents/missing");

    await expect(result).rejects.toBeInstanceOf(StorageNotFoundError);
    await expect(result).rejects.toMatchObject({ statusCode: 404 });
  });

  it("uploads a stream using the multipart Upload helper", async () => {
    const signal = new AbortController().signal;
    const stream = Readable.from(["document contents"]);
    done.mockResolvedValue({});

    await putStream("documents/doc-1/version-1", stream, "text/plain", signal);

    expect(uploadOptions).toHaveBeenCalledTimes(1);

    const options = uploadOptions.mock.calls[0]?.[0];

    expect(options?.client).toBeDefined();
    expect(options?.params).toEqual({
      Bucket: "test-bucket",
      Key: "documents/doc-1/version-1",
      Body: stream,
      ContentType: "text/plain",
    });
    expect(options?.queueSize).toBe(1);
    expect(options?.partSize).toBe(5 * 1024 * 1024);

    expect(done).toHaveBeenCalledTimes(1);
  });

  it("propagates upload failures", async () => {
    done.mockRejectedValue(new Error("Upload failed"));
    const signal = new AbortController().signal;

    await expect(
      putStream("documents/doc-1/version-1", Readable.from(["contents"]), "text/plain", signal),
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
      "Object not found: documents/doc-1/version-1",
    );
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

  it("aborts an upload when the signal is aborted", async () => {
    const controller = new AbortController();
    let finishUpload!: () => void;

    done.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishUpload = resolve;
        }),
    );
    abort.mockResolvedValue();

    const uploading = putStream(
      "documents/doc-1/version-1",
      Readable.from(["contents"]),
      "text/plain",
      controller.signal,
    );

    controller.abort();

    expect(abort).toHaveBeenCalledTimes(1);

    finishUpload();
    await uploading;
  });
});
