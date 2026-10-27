/**
 * The browser bundle supplies `Buffer` from an old polyfill that has no 64-bit
 * integer methods, while the rollup SDK and the token library call them on the
 * bare global. This adds the missing ones, with Node's semantics, to the
 * prototype of that same `Buffer`. It must use the bare global as they do and
 * not `import "buffer"`: the bundler gives the global its own polyfill copy,
 * a different object from the `buffer` package. A method that already exists
 * is left alone, so in Node this changes nothing.
 */

type ByteView = Uint8Array;
type Reader = (this: ByteView, offset?: number) => bigint;
type Writer = (this: ByteView, value: bigint, offset?: number) => number;

const WIDTH = 8;
const MODULUS = 1n << 64n;
const UNSIGNED_MAX = MODULUS - 1n;
const SIGNED_MAX = (1n << 63n) - 1n;
const SIGNED_MIN = -(1n << 63n);

function viewOf(bytes: ByteView): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function checkedOffset(bytes: ByteView, offset: number | undefined): number {
  const at = offset ?? 0;
  if (typeof at !== "number") {
    throw new TypeError(`The "offset" argument must be of type number. Received ${typeof at}`);
  }
  const last = bytes.length - WIDTH;
  if (!Number.isInteger(at) || at < 0 || at > last) {
    throw new RangeError(
      last < 0
        ? "Attempt to access memory outside buffer bounds"
        : `The value of "offset" is out of range. It must be an integer >= 0 and <= ${last}. Received ${String(at)}`,
    );
  }
  return at;
}

function checkedValue(value: bigint, min: bigint, max: bigint): bigint {
  if (typeof value !== "bigint") {
    throw new TypeError(`The "value" argument must be of type bigint. Received ${typeof value}`);
  }
  if (value < min || value > max) {
    throw new RangeError(
      `The value of "value" is out of range. It must be >= ${min} and <= ${max}.`,
    );
  }
  return value;
}

function reader(littleEndian: boolean, signed: boolean): Reader {
  return function read(this: ByteView, offset?: number): bigint {
    const at = checkedOffset(this, offset);
    const view = viewOf(this);
    return signed ? view.getBigInt64(at, littleEndian) : view.getBigUint64(at, littleEndian);
  };
}

function writer(littleEndian: boolean, signed: boolean): Writer {
  const [min, max] = signed ? [SIGNED_MIN, SIGNED_MAX] : [0n, UNSIGNED_MAX];
  return function write(this: ByteView, value: bigint, offset?: number): number {
    const checked = checkedValue(value, min, max);
    const at = checkedOffset(this, offset);
    viewOf(this).setBigUint64(at, BigInt.asUintN(64, checked), littleEndian);
    return at + WIDTH;
  };
}

const METHODS: Record<string, Reader | Writer> = {
  readBigUInt64LE: reader(true, false),
  readBigUInt64BE: reader(false, false),
  readBigInt64LE: reader(true, true),
  readBigInt64BE: reader(false, true),
  writeBigUInt64LE: writer(true, false),
  writeBigUInt64BE: writer(false, false),
  writeBigInt64LE: writer(true, true),
  writeBigInt64BE: writer(false, true),
};

const LOWERCASE_ALIASES: Record<string, string> = {
  readBigUint64LE: "readBigUInt64LE",
  readBigUint64BE: "readBigUInt64BE",
  writeBigUint64LE: "writeBigUInt64LE",
  writeBigUint64BE: "writeBigUInt64BE",
};

/** Defines each missing 64-bit method on a byte-array prototype and leaves existing ones as they are. */
export function installBigIntMethods(prototype: object): void {
  const target = prototype as Record<string, unknown>;
  const define = (name: string, method: unknown) => {
    if (typeof target[name] !== "function") {
      Object.defineProperty(prototype, name, {
        value: method,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
  };
  for (const [name, method] of Object.entries(METHODS)) define(name, method);
  for (const [alias, name] of Object.entries(LOWERCASE_ALIASES)) define(alias, METHODS[name]);
}

installBigIntMethods(Buffer.prototype);
