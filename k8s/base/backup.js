import {CronJob} from 'cron'; // https://www.npmjs.com/package/cron

// https://github.com/digitalocean/postgres-spaces-backups/blob/main/src/backup.ts 
import {
  S3Client,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { createReadStream, unlink, statSync } from "fs";
import path from "path";
import os from "os";

const key = process.env.SPACES_KEY;
const secret = process.env.SPACES_SECRET;
const bucket = process.env.SPACES_BUCKET;
const region = process.env.SPACES_REGION;
const endpoint = process.env.SPACES_ENDPOINT;

const client = new S3Client({region: region, endpoint: endpoint, credentials: {accessKeyId: key, secretAccessKey: secret},}); // https://www.codemzy.com/blog/nodejs-upload-files-digitalocean-spaces

// https://blog.harveydelaney.com/setting-up-automated-database-postgresql-backups-using-node-js-and-bash/
const date = new Date();
const today = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
const backupFile = `pg-backup-${today}.tar`;

// https://github.com/digitalocean/postgres-spaces-backups/blob/main/src/backup.ts 
const upload = async (name, filepath) => { 

    const params = {
    Bucket: bucket,
    Key: name,
    Body: createReadStream(filepath),
    };
    
    // https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/s3/command/PutObjectCommand/
    const command = new PutObjectCommand(params);
    await client.send(command);
};

const dump = async (filepath) => {

};

const del = async (filepath) => {
    
    await new Promise((resolve, reject) => {

    unlink(filepath, (err) => {
      reject({ error: err });
      return;
    });
    resolve(undefined);

  });
};

// https://github.com/digitalocean/postgres-spaces-backups/blob/main/src/backup.ts 
export const backup = async () => {

    const file_path = path.join(os.tmpdir(), backupFile);
  
    await dump(file_path);
    await upload(backupFile, file_path);
    await del(file_path);
};

// https://www.npmjs.com/package/cron
const job = new CronJob(
    '0 0 * * *', // time (midnight)
    function() {
        backup();
    },
    true, // start
    'America/Toronto' // time zone
);
