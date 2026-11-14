/** Test-only reader for core function bodies; unknown extensions fail closed. */
class Reader {
  constructor(bytes) { this.bytes = bytes; this.offset = 0; }
  byte() {
    if (this.offset >= this.bytes.length) throw new RangeError("Truncated Wasm input");
    return this.bytes[this.offset++];
  }
  leb(limit = 5) {
    let value = 0;
    for (let index = 0; index < limit; index++) {
      const byte = this.byte();
      value |= (byte & 0x7f) << (index * 7);
      if ((byte & 0x80) === 0) return value >>> 0;
    }
    throw new RangeError("Overlong Wasm immediate");
  }
  skip(length) {
    if (length < 0 || this.offset + length > this.bytes.length) throw new RangeError("Truncated Wasm field");
    this.offset += length;
  }
}

function skipInstructionImmediate(reader, opcode) {
  if ([0x02, 0x03, 0x04, 0x0c, 0x0d, 0x10, 0x12, 0x20, 0x21, 0x22, 0x23, 0x24,
    0x25, 0x26, 0x3f, 0x40, 0x41, 0xd0, 0xd2, 0xd5, 0xd6].includes(opcode)) {
    reader.leb();
  } else if (opcode === 0x42) reader.leb(10);
  else if (opcode === 0x43) reader.skip(4);
  else if (opcode === 0x44) reader.skip(8);
  else if ((opcode >= 0x28 && opcode <= 0x3e) || opcode === 0x11 || opcode === 0x13) {
    reader.leb(); reader.leb();
  } else if (opcode === 0x0e) {
    const count = reader.leb();
    for (let index = 0; index <= count; index++) reader.leb();
  } else if (opcode === 0x1c) {
    const count = reader.leb();
    for (let index = 0; index < count; index++) {
      const type = reader.byte();
      if (![0x7f, 0x7e, 0x7d, 0x7c, 0x7b, 0x70, 0x6f].includes(type)) throw new TypeError("Unsupported select type");
    }
  } else if (opcode === 0xfc) {
    const instruction = reader.leb();
    if ([8, 10, 12, 14].includes(instruction)) { reader.leb(); reader.leb(); }
    else if ([9, 11, 13, 15, 16, 17].includes(instruction)) reader.leb();
    else if (instruction > 7) throw new TypeError("Unsupported extended instruction");
  } else if (!((opcode >= 0x45 && opcode <= 0xc4)
    || [0x00, 0x01, 0x05, 0x0b, 0x0f, 0x1a, 0x1b, 0xd1, 0xd3, 0xd4].includes(opcode))) {
    throw new TypeError(`Unsupported Wasm opcode ${opcode}`);
  }
}

export function hasSimdInstructions(bytes) {
  // The engine validates framing, types and all instruction operands first.
  new WebAssembly.Module(bytes);
  const reader = new Reader(bytes);
  reader.skip(8);
  while (reader.offset < bytes.length) {
    const section = reader.byte(), length = reader.leb(), end = reader.offset + length;
    if (section === 10) {
      const count = reader.leb();
      for (let index = 0; index < count; index++) {
        const length = reader.leb(), bodyEnd = reader.offset + length, locals = reader.leb();
        for (let local = 0; local < locals; local++) {
          reader.leb();
          const type = reader.byte();
          if (type === 0x7b) return true;
          if (![0x7f, 0x7e, 0x7d, 0x7c, 0x70, 0x6f].includes(type)) throw new TypeError("Unsupported local type");
        }
        while (reader.offset < bodyEnd) {
          const opcode = reader.byte();
          if (opcode === 0xfd) return true;
          skipInstructionImmediate(reader, opcode);
          if (reader.offset > bodyEnd) throw new RangeError("Instruction exceeds its function body");
        }
      }
      if (reader.offset !== end) throw new RangeError("Invalid code section extent");
    } else reader.skip(length);
  }
  return false;
}
