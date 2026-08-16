/**
 * Exact decimal arithmetic for invoice amounts.
 *
 * Money is not a float. `0.1 + 0.2` is the reason a totals check fails on an
 * invoice that is perfectly correct, and rounding a tax amount with binary
 * floating point produces a cent of difference that a tax authority's validator
 * will reject. Everything here is integers and a scale.
 */

export class InvalidNumber extends Error {}

export class Decimal {
  /** The value multiplied by 10^scale. */
  readonly units: bigint;
  readonly scale: number;

  private constructor(units: bigint, scale: number) {
    this.units = units;
    this.scale = scale;
  }

  static parse(value: string | number): Decimal {
    const text = String(value).trim();
    if (!/^-?\d+(\.\d+)?$/.test(text)) {
      throw new InvalidNumber(`"${value}" is not a decimal number`);
    }
    const negative = text.startsWith("-");
    const [whole, fraction = ""] = text.replace("-", "").split(".");
    const units = BigInt(whole + fraction);
    return new Decimal(negative ? -units : units, fraction.length);
  }

  static zero(scale = 2): Decimal {
    return new Decimal(0n, scale);
  }

  /** Re-express at a larger scale without losing anything. */
  private at(scale: number): Decimal {
    if (scale < this.scale) throw new InvalidNumber("rescaling down would lose digits; round instead");
    return new Decimal(this.units * 10n ** BigInt(scale - this.scale), scale);
  }

  private align(other: Decimal): [Decimal, Decimal] {
    const scale = Math.max(this.scale, other.scale);
    return [this.at(scale), other.at(scale)];
  }

  add(other: Decimal): Decimal {
    const [a, b] = this.align(other);
    return new Decimal(a.units + b.units, a.scale);
  }

  subtract(other: Decimal): Decimal {
    const [a, b] = this.align(other);
    return new Decimal(a.units - b.units, a.scale);
  }

  multiply(other: Decimal): Decimal {
    return new Decimal(this.units * other.units, this.scale + other.scale);
  }

  /** Percent of this amount: 100 × 23% = 23. */
  percentOf(rate: Decimal): Decimal {
    return this.multiply(rate).divideByPowerOfTen(2);
  }

  private divideByPowerOfTen(power: number): Decimal {
    return new Decimal(this.units, this.scale + power);
  }

  /** Half-up rounding, which is what invoicing uses. */
  round(scale: number): Decimal {
    if (scale >= this.scale) return this.at(scale);
    const factor = 10n ** BigInt(this.scale - scale);
    const negative = this.units < 0n;
    const magnitude = negative ? -this.units : this.units;
    const rounded = (magnitude + factor / 2n) / factor;
    return new Decimal(negative ? -rounded : rounded, scale);
  }

  compare(other: Decimal): number {
    const [a, b] = this.align(other);
    return a.units === b.units ? 0 : a.units < b.units ? -1 : 1;
  }

  equals(other: Decimal): boolean {
    return this.compare(other) === 0;
  }

  /** Within a tolerance, for the one-cent rounding differences the rules allow. */
  equalsWithin(other: Decimal, tolerance: Decimal): boolean {
    const difference = this.subtract(other);
    const magnitude = difference.units < 0n ? new Decimal(-difference.units, difference.scale) : difference;
    return magnitude.compare(tolerance) <= 0;
  }

  toString(): string {
    const negative = this.units < 0n;
    const digits = (negative ? -this.units : this.units).toString().padStart(this.scale + 1, "0");
    const whole = digits.slice(0, digits.length - this.scale) || "0";
    const fraction = this.scale > 0 ? "." + digits.slice(digits.length - this.scale) : "";
    return (negative ? "-" : "") + whole + fraction;
  }

  /** Fixed to a scale, the form an invoice document carries. */
  toFixed(scale = 2): string {
    return this.round(scale).toString();
  }
}

export function sum(values: readonly (string | number)[]): Decimal {
  return values.reduce<Decimal>((total, value) => total.add(Decimal.parse(value)), Decimal.zero(2));
}
