// Constant request rate against TARGET for DURATION (#69). Used by
// scripts/rollout-no-drop.sh while a rollout runs. Every response that is not
// 2xx, and every connection error or timeout (status 0), counts as a failure.
// The last line of output is "RESULT {json}" for the shell script to read.
import http from 'k6/http';
import { Counter } from 'k6/metrics';

const failures = new Counter('failures');

export const options = {
  discardResponseBodies: true,
  scenarios: {
    steady: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 50),
      timeUnit: '1s',
      duration: __ENV.DURATION || '90s',
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
};

export default function () {
  const res = http.get(__ENV.TARGET, { timeout: '5s' });
  if (res.status < 200 || res.status >= 300) {
    failures.add(1);
    console.log(`FAIL ${new Date().toISOString()} status=${res.status} error=${res.error || '-'}`);
  }
}

const count = (data, name) => (data.metrics[name] ? data.metrics[name].values.count : 0);

export function handleSummary(data) {
  const result = {
    requests: count(data, 'http_reqs'),
    failures: count(data, 'failures'),
    // iterations k6 could not start at the set rate (client-side, not server drops)
    dropped_iterations: count(data, 'dropped_iterations'),
    p95_ms: Math.round(data.metrics.http_req_duration.values['p(95)']),
  };
  return { stdout: `RESULT ${JSON.stringify(result)}\n` };
}
