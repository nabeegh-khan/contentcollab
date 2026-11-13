import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { Readable } from "node:stream";

const bucket = process.env.SPACES_BUCKET;

const s3 = new S3Client({
  ...(process.env.SPACES_ENDPOINT ? { endpoint: process.env.SPACES_ENDPOINT } : {}),
  ...(process.env.SPACES_REGION ? { region: process.env.SPACES_REGION } : {}),
  credentials: {
    accessKeyId: process.env.SPACES_KEY ?? "",
    secretAccessKey: process.env.SPACES_SECRET ?? "",
  },
});

function getBucket(): string {
  if (!bucket) {
    throw new Error("SPACES_BUCKET is not configured");
  }

  return bucket;
}

// Uploads a stream using multipart upload when necessary.
// The file is streamed rather than loaded entirely into memory.
export async function putStream(key: string, stream: Readable, contentType: string): Promise<void> {
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: getBucket(),
      Key: key,
      Body: stream,
      ContentType: contentType,
    },
  });

  await upload.done();
}

// Retrieves an object as a Node.js readable stream.
export async function getStream(key: string): Promise<Readable> {
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: getBucket(),
      Key: key,
    }),
  );

  if (!response.Body) {
    throw new Error(`Object not found or empty: ${key}`);
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
