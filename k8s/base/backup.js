import {CronJob} from 'cron'; // https://www.npmjs.com/package/cron

// https://github.com/digitalocean/postgres-spaces-backups/blob/main/src/backup.ts 
import {
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createReadStream, unlink, statSync } from "fs";
import path from "path";

const key = process.env.SPACES_KEY;
const secret = process.env.SPACES_SECRET;
const bucket = process.env.SPACES_BUCKET;
const region = process.env.SPACES_REGION;
const endpoint = process.env.SPACES_ENDPOINT;


const client = new S3Client({region: region, credentials: {accessKeyId: key, secretAccessKey: secret},}); // https://www.codemzy.com/blog/nodejs-upload-files-digitalocean-spaces

// https://blog.harveydelaney.com/setting-up-automated-database-postgresql-backups-using-node-js-and-bash/
const date = new Date();
const today = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
const backupFile= `pg-backup-${today}.tar`;

const upload = async (name) => { // https://github.com/digitalocean/postgres-spaces-backups/blob/main/src/backup.ts 

    const params = {
    Bucket: bucket,
    Key: name,
    Body: createReadStream(path),
    };
    
    await new Upload({
    client,
    params: params,
  }).done();   
};

const job = new CronJob(
    '0 0 * * *', // time (midnight)
    function() {
        upload(backupFile);
    },
    true, // start
    'America/Toronto' // time zone
); // https://www.npmjs.com/package/cron
