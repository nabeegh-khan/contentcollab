import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { Readable } from "node:stream";

const bucket = process.env.SPACES_BUCKET;
function getBucket(): string {
  const configuredBucket = process.env.SPACES_BUCKET;

  if (!configuredBucket) {
    throw new Error("SPACES_BUCKET is not configured");
  }

  return configuredBucket;
}

export function validateStorageConfig(): void {
  const requiredVariables = [
    "SPACES_ENDPOINT",
    "SPACES_REGION",
    "SPACES_BUCKET",
    "SPACES_KEY",
    "SPACES_SECRET",
  ];

  const missingVariables = requiredVariables.filter((variable) => !process.env[variable]);

  if (missingVariables.length > 0) {
    throw new Error(`Missing required Spaces configuration: ${missingVariables.join(", ")}`);
  }
}

const s3 = new S3Client({
  ...(process.env.SPACES_ENDPOINT ? { endpoint: process.env.SPACES_ENDPOINT } : {}),
  ...(process.env.SPACES_REGION ? { region: process.env.SPACES_REGION } : {}),
  credentials: {
    accessKeyId: process.env.SPACES_KEY ?? "",
    secretAccessKey: process.env.SPACES_SECRET ?? "",
  },
});

// Represents an object that does not exist in Spaces.
export class StorageNotFoundError extends Error {
  readonly statusCode = 404;

  constructor(key: string) {
    super(`Object not found: ${key}`);
    this.name = "StorageNotFoundError";
  }
}

// Uploads a stream using multipart upload when necessary.
// The file is streamed rather than loaded entirely into memory.
export async function putStream(
  key: string,
  stream: Readable,
  contentType: string,
  signal: AbortSignal,
): Promise<void> {
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: getBucket(),
      Key: key,
      Body: stream,
      ContentType: contentType,
    },
    queueSize: 1,
    partSize: 5 * 1024 * 1024,
  });

  const onAbort = () => {
    void upload.abort();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();

  try {
    await upload.done();
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

// Retrieves an object as a Node.js readable stream.
export async function getStream(key: string): Promise<Readable> {
  let response;

  try {
    response = await s3.send(
      new GetObjectCommand({
        Bucket: getBucket(),
        Key: key,
      }),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "NoSuchKey" || ("Code" in error && error.Code === "NoSuchKey"))
    ) {
      throw new StorageNotFoundError(key);
    }

    throw error;
  }

  if (!response.Body) {
    throw new StorageNotFoundError(key);
  }

  return response.Body as Readable;
}

// Copies an existing object to a new key.
export async function copy(fromKey: string, toKey: string): Promise<void> {
  const encodedSource = fromKey.split("/").map(encodeURIComponent).join("/");

  await s3.send(
    new CopyObjectCommand({
      Bucket: getBucket(),
      CopySource: `${getBucket()}/${encodedSource}`,
      Key: toKey,
    }),
  );
}

// Deletes an object.
export async function remove(key: string): Promise<void> {
  await s3.send(
    new DeleteObjectCommand({
      Bucket: getBucket(),
      Key: key,
    }),
  );
}
