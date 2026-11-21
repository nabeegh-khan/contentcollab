import {CronJob} from 'cron'; // https://www.npmjs.com/package/cron

const job = new CronJob(
    '0 0 * * *', // time (midnight)
    function() {

    },
    true, // start
    'America/Toronto' // time zone
);
