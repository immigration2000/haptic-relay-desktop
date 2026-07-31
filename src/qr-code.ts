type QrBlock = {
  totalCount: number;
  dataCount: number;
};

const PAD0 = 0xec;
const PAD1 = 0x11;
const ALIGNMENT_PATTERN_POSITIONS: number[][] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50]
];

const RS_BLOCKS_LOW: QrBlock[][] = [
  [{ totalCount: 26, dataCount: 19 }],
  [{ totalCount: 44, dataCount: 34 }],
  [{ totalCount: 70, dataCount: 55 }],
  [{ totalCount: 100, dataCount: 80 }],
  [{ totalCount: 134, dataCount: 108 }],
  [{ totalCount: 86, dataCount: 68 }, { totalCount: 86, dataCount: 68 }],
  [{ totalCount: 98, dataCount: 78 }, { totalCount: 98, dataCount: 78 }],
  [{ totalCount: 121, dataCount: 97 }, { totalCount: 121, dataCount: 97 }],
  [{ totalCount: 146, dataCount: 116 }, { totalCount: 146, dataCount: 116 }],
  [{ totalCount: 86, dataCount: 68 }, { totalCount: 86, dataCount: 68 }, { totalCount: 87, dataCount: 69 }, { totalCount: 87, dataCount: 69 }]
];

export function createQrMatrix(text: string) {
  const data = new TextEncoder().encode(text);
  const version = chooseVersion(data.length);
  return buildMatrix(version, data);
}

function chooseVersion(byteLength: number) {
  for (let version = 1; version <= RS_BLOCKS_LOW.length; version += 1) {
    const blocks = RS_BLOCKS_LOW[version - 1];
    const dataCount = blocks.reduce((sum, block) => sum + block.dataCount, 0);
    const lengthBits = version < 10 ? 8 : 16;
    const neededBits = 4 + lengthBits + byteLength * 8;
    if (neededBits <= dataCount * 8) return version;
  }
  throw new Error('invite-code-too-large');
}

function buildMatrix(version: number, data: Uint8Array) {
  const size = version * 4 + 17;
  const base = createEmptyMatrix(size);
  setupFunctionPatterns(base, version);

  const dataCodewords = createDataCodewords(version, data);
  const codewords = createCodewords(version, dataCodewords);
  const candidates = Array.from({ length: 8 }, (_, mask) => {
    const matrix = cloneMatrix(base);
    mapData(matrix, codewords, mask);
    setupTypeInfo(matrix, mask);
    const normalized = normalizeMatrix(matrix);
    return { matrix: normalized, penalty: calculatePenalty(normalized) };
  });

  candidates.sort((a, b) => a.penalty - b.penalty);
  return candidates[0].matrix;
}

function createEmptyMatrix(size: number) {
  return Array.from({ length: size }, () => Array<boolean | null>(size).fill(null));
}

function cloneMatrix(matrix: (boolean | null)[][]) {
  return matrix.map(row => [...row]);
}

function normalizeMatrix(matrix: (boolean | null)[][]) {
  return matrix.map(row => row.map(cell => cell === true));
}

function setupFunctionPatterns(matrix: (boolean | null)[][], version: number) {
  const size = matrix.length;
  setupFinderPattern(matrix, 0, 0);
  setupFinderPattern(matrix, size - 7, 0);
  setupFinderPattern(matrix, 0, size - 7);
  setupTimingPattern(matrix);
  setupAlignmentPatterns(matrix, version);
  reserveTypeInfo(matrix);
  matrix[size - 8][8] = true;
}

function setupFinderPattern(matrix: (boolean | null)[][], left: number, top: number) {
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const x = left + dx;
      const y = top + dy;
      if (y < 0 || y >= matrix.length || x < 0 || x >= matrix.length) continue;
      const inOuter = dx >= 0 && dx <= 6 && (dy === 0 || dy === 6);
      const inOuterVertical = dy >= 0 && dy <= 6 && (dx === 0 || dx === 6);
      const inCenter = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
      matrix[y][x] = inOuter || inOuterVertical || inCenter;
    }
  }
}

function setupTimingPattern(matrix: (boolean | null)[][]) {
  for (let index = 8; index < matrix.length - 8; index += 1) {
    const value = index % 2 === 0;
    if (matrix[6][index] === null) matrix[6][index] = value;
    if (matrix[index][6] === null) matrix[index][6] = value;
  }
}

function setupAlignmentPatterns(matrix: (boolean | null)[][], version: number) {
  const positions = ALIGNMENT_PATTERN_POSITIONS[version - 1];
  for (const row of positions) {
    for (const col of positions) {
      if (matrix[row][col] !== null) continue;
      setupAlignmentPattern(matrix, col, row);
    }
  }
}

function setupAlignmentPattern(matrix: (boolean | null)[][], centerX: number, centerY: number) {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      matrix[centerY + dy][centerX + dx] = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
    }
  }
}

function reserveTypeInfo(matrix: (boolean | null)[][]) {
  const size = matrix.length;
  for (let index = 0; index < 9; index += 1) {
    if (index !== 6) {
      matrix[8][index] = false;
      matrix[index][8] = false;
    }
  }
  for (let index = 0; index < 8; index += 1) {
    matrix[8][size - 1 - index] = false;
    matrix[size - 1 - index][8] = false;
  }
}

function setupTypeInfo(matrix: (boolean | null)[][], mask: number) {
  const size = matrix.length;
  const bits = getBchTypeInfo((1 << 3) | mask);

  for (let index = 0; index < 15; index += 1) {
    const value = ((bits >> index) & 1) === 1;
    if (index < 6) {
      matrix[index][8] = value;
    } else if (index < 8) {
      matrix[index + 1][8] = value;
    } else {
      matrix[size - 15 + index][8] = value;
    }

    if (index < 8) {
      matrix[8][size - index - 1] = value;
    } else if (index < 9) {
      matrix[8][15 - index - 1 + 1] = value;
    } else {
      matrix[8][15 - index - 1] = value;
    }
  }
  matrix[size - 8][8] = true;
}

function getBchTypeInfo(data: number) {
  let value = data << 10;
  const generator = 0b10100110111;
  while (bitLength(value) - bitLength(generator) >= 0) {
    value ^= generator << (bitLength(value) - bitLength(generator));
  }
  return ((data << 10) | value) ^ 0b101010000010010;
}

function bitLength(value: number) {
  let length = 0;
  while (value !== 0) {
    length += 1;
    value >>>= 1;
  }
  return length;
}

function createDataCodewords(version: number, data: Uint8Array) {
  const blocks = RS_BLOCKS_LOW[version - 1];
  const dataCount = blocks.reduce((sum, block) => sum + block.dataCount, 0);
  const buffer = new BitBuffer();
  buffer.put(0b0100, 4);
  buffer.put(data.length, version < 10 ? 8 : 16);
  data.forEach(byte => buffer.put(byte, 8));

  const totalBits = dataCount * 8;
  if (buffer.length + 4 <= totalBits) buffer.put(0, 4);
  while (buffer.length % 8 !== 0) buffer.putBit(false);

  const bytes = buffer.toBytes();
  for (let index = bytes.length; index < dataCount; index += 1) {
    bytes.push(index % 2 === 0 ? PAD0 : PAD1);
  }
  return bytes;
}

function createCodewords(version: number, dataCodewords: number[]) {
  const blocks = RS_BLOCKS_LOW[version - 1];
  let offset = 0;
  const dataBlocks: number[][] = [];
  const errorBlocks: number[][] = [];
  let maxDataCount = 0;
  let maxErrorCount = 0;

  for (const block of blocks) {
    const data = dataCodewords.slice(offset, offset + block.dataCount);
    offset += block.dataCount;
    const errorCount = block.totalCount - block.dataCount;
    const error = createErrorCorrection(data, errorCount);
    dataBlocks.push(data);
    errorBlocks.push(error);
    maxDataCount = Math.max(maxDataCount, data.length);
    maxErrorCount = Math.max(maxErrorCount, error.length);
  }

  const result: number[] = [];
  for (let index = 0; index < maxDataCount; index += 1) {
    for (const block of dataBlocks) {
      if (index < block.length) result.push(block[index]);
    }
  }
  for (let index = 0; index < maxErrorCount; index += 1) {
    for (const block of errorBlocks) {
      if (index < block.length) result.push(block[index]);
    }
  }
  return result;
}

function createErrorCorrection(data: number[], errorCount: number) {
  const generator = createGeneratorPolynomial(errorCount);
  const result = Array(errorCount).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    if (factor === 0) continue;
    for (let index = 0; index < errorCount; index += 1) {
      result[index] ^= gfMultiply(generator[index], factor);
    }
  }
  return result;
}

function createGeneratorPolynomial(errorCount: number) {
  let polynomial = [1];
  for (let index = 0; index < errorCount; index += 1) {
    polynomial = multiplyPolynomials(polynomial, [1, gfPower(index)]);
  }
  return polynomial.slice(1);
}

function multiplyPolynomials(left: number[], right: number[]) {
  const result = Array(left.length + right.length - 1).fill(0);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      result[leftIndex + rightIndex] ^= gfMultiply(left[leftIndex], right[rightIndex]);
    }
  }
  return result;
}

const GF_EXP = createGfExp();
const GF_LOG = createGfLog(GF_EXP);

function createGfExp() {
  const exp = Array(512).fill(0);
  let value = 1;
  for (let index = 0; index < 255; index += 1) {
    exp[index] = value;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let index = 255; index < 512; index += 1) {
    exp[index] = exp[index - 255];
  }
  return exp;
}

function createGfLog(exp: number[]) {
  const log = Array(256).fill(0);
  for (let index = 0; index < 255; index += 1) {
    log[exp[index]] = index;
  }
  return log;
}

function gfPower(power: number) {
  return GF_EXP[power];
}

function gfMultiply(left: number, right: number) {
  if (left === 0 || right === 0) return 0;
  return GF_EXP[GF_LOG[left] + GF_LOG[right]];
}

function mapData(matrix: (boolean | null)[][], codewords: number[], mask: number) {
  const size = matrix.length;
  let row = size - 1;
  let direction = -1;
  let bitIndex = 0;

  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    while (true) {
      for (let c = 0; c < 2; c += 1) {
        const x = col - c;
        if (matrix[row][x] !== null) continue;
        const byte = codewords[Math.floor(bitIndex / 8)] ?? 0;
        const bit = ((byte >> (7 - (bitIndex % 8))) & 1) === 1;
        matrix[row][x] = maskData(mask, row, x) ? !bit : bit;
        bitIndex += 1;
      }

      row += direction;
      if (row < 0 || row >= size) {
        row -= direction;
        direction = -direction;
        break;
      }
    }
  }
}

function maskData(mask: number, row: number, col: number) {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
    default: return false;
  }
}

function calculatePenalty(matrix: boolean[][]) {
  return penaltyRuns(matrix) + penaltyBlocks(matrix) + penaltyFinderLike(matrix) + penaltyDarkRatio(matrix);
}

function penaltyRuns(matrix: boolean[][]) {
  let score = 0;
  const size = matrix.length;
  for (let row = 0; row < size; row += 1) score += scoreRun(matrix[row]);
  for (let col = 0; col < size; col += 1) score += scoreRun(matrix.map(row => row[col]));
  return score;
}

function scoreRun(values: boolean[]) {
  let score = 0;
  let runColor = values[0];
  let runLength = 1;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] === runColor) {
      runLength += 1;
    } else {
      if (runLength >= 5) score += 3 + runLength - 5;
      runColor = values[index];
      runLength = 1;
    }
  }
  if (runLength >= 5) score += 3 + runLength - 5;
  return score;
}

function penaltyBlocks(matrix: boolean[][]) {
  let score = 0;
  for (let row = 0; row < matrix.length - 1; row += 1) {
    for (let col = 0; col < matrix.length - 1; col += 1) {
      const value = matrix[row][col];
      if (value === matrix[row][col + 1] && value === matrix[row + 1][col] && value === matrix[row + 1][col + 1]) {
        score += 3;
      }
    }
  }
  return score;
}

function penaltyFinderLike(matrix: boolean[][]) {
  const pattern = [true, false, true, true, true, false, true, false, false, false, false];
  const reverse = [...pattern].reverse();
  let score = 0;
  const rows = matrix;
  const cols = matrix.map((_, col) => matrix.map(row => row[col]));
  for (const line of [...rows, ...cols]) {
    for (let index = 0; index <= line.length - pattern.length; index += 1) {
      const slice = line.slice(index, index + pattern.length);
      if (samePattern(slice, pattern) || samePattern(slice, reverse)) score += 40;
    }
  }
  return score;
}

function samePattern(values: boolean[], pattern: boolean[]) {
  return pattern.every((value, index) => values[index] === value);
}

function penaltyDarkRatio(matrix: boolean[][]) {
  const dark = matrix.flat().filter(Boolean).length;
  const total = matrix.length * matrix.length;
  const percent = (dark * 100) / total;
  return Math.floor(Math.abs(percent - 50) / 5) * 10;
}

class BitBuffer {
  private readonly bits: boolean[] = [];

  get length() {
    return this.bits.length;
  }

  put(value: number, length: number) {
    for (let index = length - 1; index >= 0; index -= 1) {
      this.putBit(((value >> index) & 1) === 1);
    }
  }

  putBit(value: boolean) {
    this.bits.push(value);
  }

  toBytes() {
    const result: number[] = [];
    for (let index = 0; index < this.bits.length; index += 8) {
      let byte = 0;
      for (let offset = 0; offset < 8; offset += 1) {
        byte <<= 1;
        if (this.bits[index + offset]) byte |= 1;
      }
      result.push(byte);
    }
    return result;
  }
}
