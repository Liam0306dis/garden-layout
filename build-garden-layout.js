'use strict';

const fs = require('fs');
const path = require('path');

const DATA_URL = 'https://mg-api.ariedam.fr/data';
const TEMPLATE_PATH = path.join(__dirname, 'index.template.html');
const OUTPUT_PATH = path.join(__dirname, 'index.html');
const TALL_PLANT_SPRITES = new Set([
  'Bamboo', 'Cactus', 'DawnCelestialPlant', 'DawnCelestialPlantActive', 'DawnCelestialPlatform',
  'MoonCelestialPlant', 'MoonCelestialPlantActive', 'MoonCelestialPlatform', 'PricklyPearPlant',
  'StarweaverPlant', 'StarweaverPlatform', 'ThunderCelestialPlant', 'ThunderCelestialPlantActive',
  'ThunderCelestialPlatform',
]);
const STACK_FAMILY_BASE = {
  Snowdrop:'Snowdrop',
  Daisy:'Daisy',
  PurpleDaisy:'Daisy',
  Clover:'Clover',
  FourLeafClover:'Clover',
};

async function fetchChecked(url) {
  const response = await fetch(url, { headers:{ 'User-Agent':'Magic Garden Layout Planner' } });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response;
}

function spriteName(url) {
  if (!url) return '';
  return decodeURIComponent(new URL(url).pathname.split('/').pop() || '').replace(/\.png$/i, '');
}

async function loadPlantFrameMetadata(data) {
  const sampleUrl = Object.values(data.plants || {}).find(entry => entry?.plant?.sprite)?.plant?.sprite;
  const version = sampleUrl ? new URL(sampleUrl).searchParams.get('v') : '';
  if (!version) return new Map();
  const baseUrl = `https://magicgarden.gg/version/${version}/assets/`;
  const manifest = await (await fetchChecked(new URL('manifest.json', baseUrl))).json();
  const bundle = (manifest.bundles || []).find(entry => entry.name === 'default');
  const queue = [];
  for (const asset of bundle?.assets || []) {
    for (const source of Array.isArray(asset.src) ? asset.src : [asset.src]) {
      if (typeof source === 'string' && source.endsWith('.json')) queue.push(new URL(source, baseUrl).toString());
    }
  }
  const seen = new Set();
  const frames = new Map();
  while (queue.length) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    const atlas = await (await fetchChecked(url)).json();
    if (!atlas?.frames || !atlas?.meta?.image) continue;
    for (const [key, frame] of Object.entries(atlas.frames)) {
      if (!/^sprite\/(plant|tallplant|crop|mutation)\//.test(key)) continue;
      const name = key.split('/').pop();
      if (!frames.has(name)) frames.set(name, { ...frame, category:key.split('/')[1] });
    }
    for (const related of atlas.meta.related_multi_packs || []) queue.push(new URL(related, url).toString());
  }
  return frames;
}

async function main() {
  const data = await (await fetchChecked(DATA_URL)).json();
  const plantFrames = await loadPlantFrameMetadata(data);
  const catalog = [];
  const spriteCache = new Map();
  const missingPlantFrames = [];
  const missingCropFrames = [];

  const toDataUrl = async url => {
    if (!spriteCache.has(url)) {
      spriteCache.set(url, (async () => {
        const response = await fetchChecked(url);
        const mime = (response.headers.get('content-type') || 'image/png').split(';')[0];
        const bytes = Buffer.from(await response.arrayBuffer());
        const isPng = bytes.length >= 24 && bytes.toString('ascii', 1, 4) === 'PNG';
        return {
          dataUrl:`data:${mime};base64,${bytes.toString('base64')}`,
          width:isPng ? bytes.readUInt32BE(16) : 0,
          height:isPng ? bytes.readUInt32BE(20) : 0,
        };
      })());
    }
    return spriteCache.get(url);
  };

  const plantEntries = Object.entries(data.plants || {});
  for (const [id, entry] of plantEntries) {
    const plant = entry.plant;
    if (!plant?.sprite) continue;
    const plantFrameName = spriteName(plant.sprite);
    const cropFrameName = spriteName(entry.crop?.sprite);
    const plantFrame = plantFrames.get(plantFrameName) || {};
    const cropFrame = plantFrames.get(cropFrameName) || {};
    if (!plantFrames.has(plantFrameName)) missingPlantFrames.push(`${id}:${plantFrameName}`);
    if (!plantFrames.has(cropFrameName)) missingCropFrames.push(`${id}:${cropFrameName}`);
    catalog.push({
      kind:'plant',
      id,
      name:plant.name || id,
      rarity:entry.seed?.rarity || '',
      spriteUrl:plant.sprite,
      cropSpriteUrl:entry.crop?.sprite || null,
      harvestType:plant.harvestType || 'Single',
      cropScale:Number(entry.crop?.baseTileScale) || .5,
      maxScale:Math.max(1, Number(entry.crop?.maxScale) || 1),
      stackFamily:STACK_FAMILY_BASE[id] || null,
      stackCapacity:STACK_FAMILY_BASE[id] ? Number(data.plants?.[STACK_FAMILY_BASE[id]]?.plant?.slotCapacity) || 1 : 1,
      cropVisualScale:Number(entry.crop?.visualScaleMultiplier) || 1,
      cropOffsetX:Number(entry.crop?.plantTransform?.offsetXPixels) || 0,
      cropOffsetY:Number(entry.crop?.plantTransform?.offsetYPixels) || 0,
      slotOffsets:Array.isArray(plant.slotOffsets) ? plant.slotOffsets : [],
      scale:Math.max(.72, Math.min(1.3, Number(plant.baseTileScale) || 1)),
      plantAnchorX:Number(plantFrame.anchor?.x ?? .5),
      plantAnchorY:Number(plantFrame.anchor?.y ?? .5),
      plantPixelRatio:Number(plantFrame.sourcePixelRatio) || 1,
      plantIsTall:TALL_PLANT_SPRITES.has(plantFrameName),
      cropAnchorX:Number(cropFrame.anchor?.x ?? .5),
      cropAnchorY:Number(cropFrame.anchor?.y ?? 1),
      cropPixelRatio:Number(cropFrame.sourcePixelRatio) || 1,
      cropIsTall:TALL_PLANT_SPRITES.has(cropFrameName),
    });
  }

  const decorEntries = Object.entries(data.decor || {});
  for (const [id, entry] of decorEntries) {
    if (!entry?.sprite) continue;
    catalog.push({
      kind:'decor',
      id,
      name:entry.name || id,
      rarity:entry.rarity || '',
      spriteUrl:entry.sprite,
      scale:1,
    });
  }

  const mutations = Object.entries(data.mutations || {}).map(([id, entry]) => {
    const frame = plantFrames.get(spriteName(entry.sprite)) || {};
    return {
      id,
      name:entry.name || id,
      color:entry.color || '',
      coinMultiplier:Number(entry.coinMultiplier) || 0,
      spriteUrl:entry.sprite || null,
      spriteAnchorX:Number(frame.anchor?.x ?? .5),
      spriteAnchorY:Number(frame.anchor?.y ?? .5),
      spritePixelRatio:Number(frame.sourcePixelRatio) || 1,
    };
  });

  const jobs = [];
  for (const item of catalog) {
    jobs.push(async () => {
      const embedded = await toDataUrl(item.spriteUrl);
      item.sprite = embedded.dataUrl;
      item.spriteWidth = embedded.width;
      item.spriteHeight = embedded.height;
      delete item.spriteUrl;
    });
    if (item.cropSpriteUrl) jobs.push(async () => {
      const embedded = await toDataUrl(item.cropSpriteUrl);
      item.cropSprite = embedded.dataUrl;
      item.cropWidth = embedded.width;
      item.cropHeight = embedded.height;
      delete item.cropSpriteUrl;
    });
    else delete item.cropSpriteUrl;
  }
  for (const mutation of mutations) {
    if (mutation.spriteUrl) jobs.push(async () => {
      const embedded = await toDataUrl(mutation.spriteUrl);
      mutation.sprite = embedded.dataUrl;
      mutation.spriteWidth = embedded.width;
      mutation.spriteHeight = embedded.height;
      delete mutation.spriteUrl;
    });
  }

  const workers = Array.from({ length:10 }, async (_, workerIndex) => {
    for (let index = workerIndex; index < jobs.length; index += 10) await jobs[index]();
  });
  await Promise.all(workers);

  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  if (!template.includes('/*__CATALOG__*/') || !template.includes('/*__MUTATIONS__*/')) throw new Error('catalog marker is missing');
  const output = template
    .replace('/*__CATALOG__*/', JSON.stringify(catalog))
    .replace('/*__MUTATIONS__*/', JSON.stringify(mutations));
  fs.writeFileSync(OUTPUT_PATH, output);
  console.log(`Built ${OUTPUT_PATH}`);
  console.log(`${plantEntries.length} plants, ${decorEntries.length} decorations, ${mutations.length} mutations, ${spriteCache.size} embedded sprites`);
  console.log(`${missingPlantFrames.length} plant frames and ${missingCropFrames.length} crop frames missing atlas metadata`);
  if (missingPlantFrames.length || missingCropFrames.length) console.log({ missingPlantFrames, missingCropFrames });
  console.log(`${(Buffer.byteLength(output) / 1024 / 1024).toFixed(2)} MB`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
