const fs = require('fs');
const { PNG } = require('pngjs');

const loadPng = (filePath) => {
  const buffer = fs.readFileSync(filePath);
  return PNG.sync.read(buffer);
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const analyzePng = (filePath) => {
  const png = loadPng(filePath);
  const { data, width, height } = png;
  let totalLuma = 0;
  let totalLumaSq = 0;
  const histogram = new Array(256).fill(0);
  const colorBuckets = {};

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const luma = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    totalLuma += luma;
    totalLumaSq += luma * luma;
    histogram[luma] += 1;
    const bucket = `${Math.round(r / 32)}-${Math.round(g / 32)}-${Math.round(b / 32)}`;
    colorBuckets[bucket] = (colorBuckets[bucket] || 0) + 1;
  }

  const pixelCount = width * height;
  const mean = totalLuma / pixelCount;
  const variance = totalLumaSq / pixelCount - mean * mean;
  const contrast = Math.sqrt(Math.max(variance, 0));

  const palette = Object.entries(colorBuckets)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([bucket]) => {
      const [r, g, b] = bucket.split('-').map((value) => clamp(parseInt(value, 10) * 32, 0, 255));
      return `rgb(${r}, ${g}, ${b})`;
    });

  return {
    brightness: mean,
    contrast,
    palette,
  };
};

const sharpnessScore = (filePath) => {
  const png = loadPng(filePath);
  const { data, width, height } = png;
  let score = 0;
  for (let y = 1; y < height - 1; y += 4) {
    for (let x = 1; x < width - 1; x += 4) {
      const idx = (width * y + x) << 2;
      const luma = 0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2];
      const rightIdx = (width * y + (x + 1)) << 2;
      const downIdx = (width * (y + 1) + x) << 2;
      const lumaRight =
        0.2126 * data[rightIdx] + 0.7152 * data[rightIdx + 1] + 0.0722 * data[rightIdx + 2];
      const lumaDown =
        0.2126 * data[downIdx] + 0.7152 * data[downIdx + 1] + 0.0722 * data[downIdx + 2];
      score += Math.abs(luma - lumaRight) + Math.abs(luma - lumaDown);
    }
  }
  return score / ((width * height) / 16);
};

module.exports = {
  analyzePng,
  sharpnessScore,
};
