import { describe, expect, it } from "vitest";
import { installBigIntMethods } from "@/lib/bufferBigInt";

class PlainBytes extends Uint8Array {
  declare readBigUInt64LE: (offset?: number) => bigint;
  declare readBigUInt64BE: (offset?: number) => bigint;
  declare readBigInt64BE: (offset?: number) => bigint;
  declare writeBigUInt64LE: (value: bigint, offset?: number) => number;
  declare writeBigInt64LE: (value: bigint, offset?: number) => number;
}
installBigIntMethods(PlainBytes.prototype);

type Methods = Record<string, (...args: unknown[]) => unknown>;

const UNSIGNED = [0n, 1n, 1n << 32n, (1n << 64n) - 1n];
const SIGNED = [0n, 1n, -1n, 1n << 32n, -(1n << 63n), (1n << 63n) - 1n];
const OFFSETS = [0, 1, 7, 8];

function pair(size: number): [PlainBytes, Buffer] {
  return [new PlainBytes(size), Buffer.alloc(size)];
}

function plainWithBytes(bytes: Buffer): PlainBytes {
  const plain = new PlainBytes(bytes.length);
  plain.set(bytes);
  return plain;
}

describe("64-bit methods on a byte array without them", () => {
  const writes: [string, bigint[]][] = [
    ["writeBigUInt64LE", UNSIGNED],
    ["writeBigUInt64BE", UNSIGNED],
    ["writeBigUint64LE", UNSIGNED],
    ["writeBigUint64BE", UNSIGNED],
    ["writeBigInt64LE", SIGNED],
    ["writeBigInt64BE", SIGNED],
  ];

  for (const [name, values] of writes) {
    it(`${name} writes the bytes Node writes and returns offset + 8`, () => {
      for (const value of values) {
        for (const offset of OFFSETS) {
          const [plain, native] = pair(16);
          const ours = (plain as unknown as Methods)[name]!(value, offset);
          const theirs = (native as unknown as Methods)[name]!(value, offset);
          expect(ours).toBe(theirs);
          expect(Buffer.from(plain)).toEqual(native);
        }
      }
    });

    it(`${name} defaults the offset to 0`, () => {
      const [plain, native] = pair(8);
      (plain as unknown as Methods)[name]!(values[1]);
      (native as unknown as Methods)[name]!(values[1]);
      expect(Buffer.from(plain)).toEqual(native);
    });
  }

  const reads: [string, bigint[]][] = [
    ["readBigUInt64LE", UNSIGNED],
    ["readBigUInt64BE", UNSIGNED],
    ["readBigUint64LE", UNSIGNED],
    ["readBigUint64BE", UNSIGNED],
    ["readBigInt64LE", SIGNED],
    ["readBigInt64BE", SIGNED],
  ];

  for (const [name, values] of reads) {
    it(`${name} reads what Node reads`, () => {
      const writeName = name.replace("read", "write");
      for (const value of values) {
        for (const offset of OFFSETS) {
          const bytes = Buffer.alloc(16);
          (bytes as unknown as Methods)[writeName]!(value, offset);
          const plain = plainWithBytes(bytes);
          expect((plain as unknown as Methods)[name]!(offset)).toBe(value);
          expect((bytes as unknown as Methods)[name]!(offset)).toBe(value);
        }
        const bytes = Buffer.alloc(8);
        (bytes as unknown as Methods)[writeName]!(value);
        expect((plainWithBytes(bytes) as unknown as Methods)[name]!()).toBe(value);
      }
    });
  }

  it("works on a view that starts partway into its buffer", () => {
    const backing = new Uint8Array(24);
    const view = new PlainBytes(backing.buffer, 8, 16);
    view.writeBigUInt64LE(0x0102030405060708n, 4);
    expect([...backing.slice(12, 20)]).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
    expect(view.readBigUInt64LE(4)).toBe(0x0102030405060708n);
  });

  const outOfRangeValues: [string, bigint][] = [
    ["writeBigUInt64LE", -1n],
    ["writeBigUInt64LE", 1n << 64n],
    ["writeBigUInt64BE", -1n],
    ["writeBigUInt64BE", 1n << 64n],
    ["writeBigInt64LE", 1n << 63n],
    ["writeBigInt64LE", -(1n << 63n) - 1n],
    ["writeBigInt64BE", 1n << 63n],
    ["writeBigInt64BE", -(1n << 63n) - 1n],
  ];

  for (const [name, value] of outOfRangeValues) {
    it(`${name} refuses ${value} with a RangeError, as Node does`, () => {
      const [plain, native] = pair(8);
      expect(() => (native as unknown as Methods)[name]!(value, 0)).toThrow(RangeError);
      expect(() => (plain as unknown as Methods)[name]!(value, 0)).toThrow(RangeError);
      expect([...plain]).toEqual(new Array(8).fill(0));
    });
  }

  it("refuses an offset outside the array with a RangeError, as Node does", () => {
    const [plain, native] = pair(16);
    for (const offset of [-1, 9, 1.5, Number.NaN]) {
      expect(() => native.readBigUInt64LE(offset)).toThrow(RangeError);
      expect(() => plain.readBigUInt64LE(offset)).toThrow(RangeError);
      expect(() => native.writeBigInt64LE(1n, offset)).toThrow(RangeError);
      expect(() => plain.writeBigInt64LE(1n, offset)).toThrow(RangeError);
    }
    expect(() => native.readBigInt64BE(-1)).toThrow(RangeError);
    expect(() => plain.readBigInt64BE(-1)).toThrow(RangeError);
  });

  it("refuses an array shorter than eight bytes with a RangeError", () => {
    expect(() => new PlainBytes(7).readBigUInt64LE(0)).toThrow(RangeError);
    expect(() => new PlainBytes(7).writeBigUInt64LE(1n, 0)).toThrow(RangeError);
  });

  it("leaves a method that already exists alone", () => {
    const existing = () => 42n;
    class Marked extends Uint8Array {}
    Object.defineProperty(Marked.prototype, "readBigUInt64LE", { value: existing });
    installBigIntMethods(Marked.prototype);
    const methods = Marked.prototype as unknown as Methods;
    expect(methods.readBigUInt64LE).toBe(existing);
    expect(typeof methods.readBigUInt64BE).toBe("function");
  });
});
