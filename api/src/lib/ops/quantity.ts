// Kubernetes quantities ("1900m", "253000000n", "3074892Ki") as plain numbers for the operations panel (D31).
const NANO_PER_MILLI = 1_000_000;
const MILLI_PER_CORE = 1000;
const KI = 1024;
const MI_POWER = 2;
const GI_POWER = 3;
const TI_POWER = 4;
const BYTES_PER_MIB = KI * KI;
const BINARY_BYTES: Record<string, number> = {
  Ki: KI,
  Mi: KI ** MI_POWER,
  Gi: KI ** GI_POWER,
  Ti: KI ** TI_POWER,
};

// A number with an optional unit: "1900m" and "3074892Ki" match; "12 parsecs" and "-5" do not.
// Tester: https://regex101.com/?regex=%5E(%5Cd%2B(%3F%3A%5C.%5Cd%2B)%3F)(%5BA-Za-z%5D*)%24
function split(quantity: string): { amount: number; suffix: string } {
  const match = /^(\d+(?:\.\d+)?)([A-Za-z]*)$/.exec(quantity.trim());
  if (!match) throw new Error(`unreadable quantity: ${quantity}`);
  return { amount: Number(match[1]), suffix: match[2] ?? "" };
}

/** CPU as whole millicores, from cores ("2"), millicores ("1900m") or nanocores ("253000000n"). */
export function parseCpuMillicores(quantity: string): number {
  const { amount, suffix } = split(quantity);
  if (suffix === "") return Math.round(amount * MILLI_PER_CORE);
  if (suffix === "m") return Math.round(amount);
  if (suffix === "n") return Math.round(amount / NANO_PER_MILLI);
  throw new Error(`unreadable CPU quantity: ${quantity}`);
}

/** Memory as whole MiB, from bytes or a Ki, Mi, Gi or Ti suffix. */
export function parseMemoryMiB(quantity: string): number {
  const { amount, suffix } = split(quantity);
  const unit = suffix === "" ? 1 : BINARY_BYTES[suffix];
  if (unit === undefined) throw new Error(`unreadable memory quantity: ${quantity}`);
  return Math.round((amount * unit) / BYTES_PER_MIB);
}
