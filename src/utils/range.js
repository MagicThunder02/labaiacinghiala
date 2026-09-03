function parseByteRange(rangeHeader, fileSize) {
  if (!rangeHeader) return null;
  if (!Number.isInteger(fileSize) || fileSize < 0) return { invalid: true };

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return { invalid: true };

  const [, startText, endText] = match;
  if (!startText && !endText) return { invalid: true };

  let start;
  let end;

  if (!startText) {
    const suffixLength = Number.parseInt(endText, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return { invalid: true };
    start = Math.max(fileSize - suffixLength, 0);
    end = Math.max(fileSize - 1, 0);
  } else {
    start = Number.parseInt(startText, 10);
    end = endText ? Number.parseInt(endText, 10) : fileSize - 1;
  }

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < start ||
    start >= fileSize
  ) {
    return { invalid: true };
  }

  end = Math.min(end, fileSize - 1);
  return { start, end, length: end - start + 1 };
}

module.exports = { parseByteRange };
