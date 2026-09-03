(function attachBaiaMediaPalette(globalObject, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  globalObject.BaiaMediaPalette = api;
}(typeof globalThis !== 'undefined' ? globalThis : window, () => {
  'use strict';

  const DEFAULT_PALETTE = Object.freeze({
    base: [22, 25, 19],
    primary: [108, 139, 72],
    secondary: [55, 95, 130],
    accentA: [164, 88, 72],
    accentB: [126, 103, 176],
  });

  const cache = new Map();
  const MAX_CACHE_ITEMS = 72;

  function clamp(value, minimum = 0, maximum = 1) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function normalizeRgb(rgb) {
    return rgb.map((value) => Math.round(clamp(Number(value) || 0, 0, 255)));
  }

  function rgbToHsl(rgb) {
    const [red, green, blue] = rgb.map((value) => clamp(value / 255));
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    const lightness = (maximum + minimum) / 2;
    const delta = maximum - minimum;
    if (!delta) return [0, 0, lightness];
    const saturation = delta / (1 - Math.abs(2 * lightness - 1));
    let hue;
    if (maximum === red) hue = ((green - blue) / delta) % 6;
    else if (maximum === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
    return [((hue * 60) + 360) % 360, saturation, lightness];
  }

  function hslToRgb(hsl) {
    const [rawHue, saturation, lightness] = hsl;
    const hue = ((rawHue % 360) + 360) % 360;
    const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const sector = hue / 60;
    const intermediate = chroma * (1 - Math.abs((sector % 2) - 1));
    let rgb = [0, 0, 0];
    if (sector < 1) rgb = [chroma, intermediate, 0];
    else if (sector < 2) rgb = [intermediate, chroma, 0];
    else if (sector < 3) rgb = [0, chroma, intermediate];
    else if (sector < 4) rgb = [0, intermediate, chroma];
    else if (sector < 5) rgb = [intermediate, 0, chroma];
    else rgb = [chroma, 0, intermediate];
    const match = lightness - chroma / 2;
    return normalizeRgb(rgb.map((value) => (value + match) * 255));
  }

  function srgbToLinear(value) {
    const channel = clamp(value / 255);
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }

  function rgbToOklab(rgb) {
    const red = srgbToLinear(rgb[0]);
    const green = srgbToLinear(rgb[1]);
    const blue = srgbToLinear(rgb[2]);
    const l = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
    const m = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
    const s = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  }

  function oklabDistance(first, second) {
    const a = rgbToOklab(first);
    const b = rgbToOklab(second);
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }

  function enhanceColor(rgb, saturationMultiplier, minimumLightness, maximumLightness) {
    const [hue, saturation, lightness] = rgbToHsl(rgb);
    return hslToRgb([
      hue,
      clamp(saturation * saturationMultiplier + 0.035, 0.12, 0.92),
      clamp(lightness, minimumLightness, maximumLightness),
    ]);
  }

  function generatedVariant(primary, hueOffset, saturationMultiplier, lightnessOffset) {
    const [hue, saturation, lightness] = rgbToHsl(primary);
    return hslToRgb([
      hue + hueOffset,
      clamp(saturation * saturationMultiplier + 0.08, 0.28, 0.88),
      clamp(lightness + lightnessOffset, 0.3, 0.7),
    ]);
  }

  function buildBaseColor(colors) {
    const blended = colors.reduce((totals, color, index) => {
      const weight = index === 0 ? 1.4 : 1;
      totals[0] += color[0] * weight;
      totals[1] += color[1] * weight;
      totals[2] += color[2] * weight;
      totals[3] += weight;
      return totals;
    }, [0, 0, 0, 0]);
    const average = blended.slice(0, 3).map((value) => value / blended[3]);
    const [hue, saturation, lightness] = rgbToHsl(average);
    return hslToRgb([hue, clamp(saturation * 0.58, 0.18, 0.58), clamp(0.105 + lightness * 0.12, 0.12, 0.2)]);
  }

  function analyzePixels(pixels, options = {}) {
    if (!pixels || pixels.length < 4) return { ...DEFAULT_PALETTE };
    const stride = Math.max(1, Number(options.stride) || 1);
    const bins = new Map();

    for (let index = 0; index < pixels.length; index += 4 * stride) {
      const alpha = Number(pixels[index + 3]);
      if (alpha < 170) continue;
      const rgb = [Number(pixels[index]), Number(pixels[index + 1]), Number(pixels[index + 2])];
      const [hue, saturation, lightness] = rgbToHsl(rgb);
      if (lightness < 0.035 || lightness > 0.965) continue;
      const quantized = rgb.map((value) => Math.round(value / 20) * 20);
      const key = quantized.join(',');
      const entry = bins.get(key) || { count: 0, sum: [0, 0, 0], saturation: 0, lightness: 0 };
      entry.count += 1;
      entry.sum[0] += rgb[0];
      entry.sum[1] += rgb[1];
      entry.sum[2] += rgb[2];
      entry.saturation += saturation;
      entry.lightness += lightness;
      bins.set(key, entry);
    }

    const candidates = [...bins.values()].map((entry) => {
      const rgb = entry.sum.map((value) => value / entry.count);
      const lab = rgbToOklab(rgb);
      const chroma = Math.hypot(lab[1], lab[2]);
      const saturation = entry.saturation / entry.count;
      const lightness = entry.lightness / entry.count;
      const frequency = Math.pow(entry.count, 0.58);
      const vividness = 0.7 + saturation * 1.85 + chroma * 4.2;
      const usableLightness = 0.78 + (1 - Math.min(1, Math.abs(lightness - 0.56) / 0.56)) * 0.48;
      return { rgb: normalizeRgb(rgb), score: frequency * vividness * usableLightness, chroma, lightness };
    }).sort((first, second) => second.score - first.score);

    if (!candidates.length) return { ...DEFAULT_PALETTE };

    const selected = [candidates[0]];
    const maximumScore = candidates[0].score || 1;
    const thresholds = [0.105, 0.09, 0.072];

    while (selected.length < 4) {
      const threshold = thresholds[Math.min(selected.length - 1, thresholds.length - 1)];
      let best = null;
      let bestUtility = -Infinity;
      for (const candidate of candidates) {
        if (selected.includes(candidate)) continue;
        const minimumDistance = Math.min(...selected.map((item) => oklabDistance(item.rgb, candidate.rgb)));
        if (minimumDistance < threshold) continue;
        const scoreRatio = candidate.score / maximumScore;
        const utility = scoreRatio * 0.72 + minimumDistance * 3.35 + candidate.chroma * 1.7;
        if (utility > bestUtility) {
          best = candidate;
          bestUtility = utility;
        }
      }
      if (!best) break;
      selected.push(best);
    }

    const rawPrimary = selected[0].rgb;
    const remaining = selected.slice(1);
    const secondaryCandidate = remaining.sort((first, second) => {
      const firstValue = oklabDistance(rawPrimary, first.rgb) * 2.4 + first.score / maximumScore;
      const secondValue = oklabDistance(rawPrimary, second.rgb) * 2.4 + second.score / maximumScore;
      return secondValue - firstValue;
    })[0];

    const primary = enhanceColor(rawPrimary, 1.1, 0.26, 0.68);
    const secondary = enhanceColor(secondaryCandidate?.rgb || generatedVariant(primary, 78, 0.92, -0.02), 1.14, 0.25, 0.68);
    const accentCandidates = selected
      .filter((candidate) => candidate !== selected[0] && candidate !== secondaryCandidate)
      .sort((first, second) => second.chroma - first.chroma);
    const accentA = enhanceColor(accentCandidates[0]?.rgb || generatedVariant(primary, 148, 1.08, 0.06), 1.24, 0.32, 0.72);
    const accentB = enhanceColor(accentCandidates[1]?.rgb || generatedVariant(secondary, 112, 1.05, 0.08), 1.28, 0.34, 0.72);
    const base = buildBaseColor([primary, secondary, accentA, accentB]);

    return { base, primary, secondary, accentA, accentB };
  }

  function drawImageToCanvas(image, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Canvas non disponibile');
    context.drawImage(image, 0, 0, width, height);
    return context.getImageData(0, 0, width, height).data;
  }

  async function loadImage(source, options = {}) {
    const image = new Image();
    image.decoding = 'async';
    if (options.crossOrigin) image.crossOrigin = options.crossOrigin;
    const loaded = new Promise((resolve, reject) => {
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Immagine non disponibile per la palette'));
    });
    image.src = source;
    if (typeof image.decode === 'function') {
      try {
        await image.decode();
        return image;
      } catch {
        return loaded;
      }
    }
    return loaded;
  }

  function remember(key, promise) {
    cache.set(key, promise);
    while (cache.size > MAX_CACHE_ITEMS) cache.delete(cache.keys().next().value);
    promise.catch(() => cache.delete(key));
    return promise;
  }

  async function extractFromUrl(source, options = {}) {
    if (!source) return { ...DEFAULT_PALETTE };
    const width = Math.max(24, Math.min(128, Number(options.width) || 72));
    const height = Math.max(24, Math.min(128, Number(options.height) || 72));
    const key = `${source}|${width}x${height}`;
    if (cache.has(key)) return cache.get(key);
    return remember(key, (async () => {
      const image = await loadImage(source, options);
      return analyzePixels(drawImageToCanvas(image, width, height));
    })());
  }

  function applyCssVariables(target, palette = DEFAULT_PALETTE, prefix = 'media-color') {
    if (!target?.style?.setProperty) return;
    const resolved = { ...DEFAULT_PALETTE, ...palette };
    target.style.setProperty(`--${prefix}-base`, normalizeRgb(resolved.base).join(', '));
    target.style.setProperty(`--${prefix}-a`, normalizeRgb(resolved.primary).join(', '));
    target.style.setProperty(`--${prefix}-b`, normalizeRgb(resolved.secondary).join(', '));
    target.style.setProperty(`--${prefix}-c`, normalizeRgb(resolved.accentA).join(', '));
    target.style.setProperty(`--${prefix}-d`, normalizeRgb(resolved.accentB).join(', '));
  }

  return Object.freeze({
    DEFAULT_PALETTE,
    analyzePixels,
    applyCssVariables,
    extractFromUrl,
    oklabDistance,
    rgbToHsl,
  });
}));
